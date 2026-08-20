/**
 * shakeDetection.ts
 * ------------------------------------------------------------
 * 揺れ検知エンジン(新方式・ゼロから再設計)。
 *
 * 旧実装(KyoshinEewViewerのShakeDetectionEngine.cs移植版)は、近傍点の
 * 重み付きスコアと複数tick分の履歴平均でスパイクを除外してから検知して
 * いたため、実際に揺れ始めてからイベントとして確定するまでに数tick分の
 * タイムラグがあった。
 *
 * 新実装は「検知の速さ」を最優先に、考え方から作り直している。
 *
 *   ある観測点の値が急上昇した(前tickからの上昇量がしきい値以上)とき、
 *   それが本物の揺れなら、地理的に近い別の観測点でも"ほぼ同時に"同じ
 *   ような急上昇が起きているはず(P波・S波は面的に伝播するため)。逆に、
 *   単独観測点だけが跳ねているなら機器ノイズ・瞬間的なスパイクの可能性
 *   が高い。
 *
 * → 履歴平均やスコアの積み上げを待たず、「近傍2点がほぼ同時期に急上昇
 *   した瞬間」を捉えた、その場でイベントを確定させる(2点同時多発検知)。
 *   これにより、旧実装にあった「履歴が貯まるまで待つ」「多数の観測点が
 *   揃うまで確定しない」という遅延要因を取り除いている。
 *
 * パラメータ(DEFAULT_SHAKE_DETECTION_PARAMS)は仮の値。実データを見ながら
 * 調整すること。
 *
 * 入出力の形は旧実装を踏襲している(App.tsx側の変更を不要にするため):
 *   - initialize(stations): 観測点マスタが変わった時だけ呼ぶ
 *   - processTick(valuesMap, now): Map<観測点id, 震度相当値> を渡すたびに
 *     呼ぶ → 現在のイベント一覧(確定/未確定含む)を返す
 *
 * イベントの形(App.tsx側が参照する主要フィールド):
 *   id, level(0〜4), pointCount, centerLat, centerLon, confirmed
 */

export const DEFAULT_SHAKE_DETECTION_PARAMS = {
  // 近傍点探索(initialize時に1度だけ計算。SetupNearPoints相当)
  neighborRadiusKm: 25,        // これより近い観測点同士を「近傍」とみなす
  maxNeighbors: 6,             // 近傍点として保持する最大数

  // トリガー条件(1tickごとの即時判定。履歴平均は使わない)
  riseThreshold: 0.5,          // 前tickからの上昇量がこれ以上で「急上昇」とみなす
  isolatedRiseThreshold: 1.2,  // 近傍が無い孤立点が単独トリガーするための上昇量(離島等)

  // 同時多発判定(2点同時多発検知の核)
  corroborationWindowTicks: 2, // 自分が急上昇したtickを基準に、近傍がその前後
                                // 何tick以内に急上昇していれば「同時」とみなすか
                                // (P波の伝播で近傍到達に数tickのずれが出るのを許容)

  // 未確定(pending)状態の保持
  pendingExpireTicks: 3,       // 単独で急上昇した点が、これだけtickが経っても
                                // どの近傍からも裏付けを得られなければ静かに諦める

  // 震度相当値(連続値) → イベントレベル(0〜4)への割り当て。
  // 4つのしきい値でレベル1〜4を区切る(この値未満はレベル0)。
  levelThresholds: [0.5, 2.0, 3.5, 5.0],

  // イベントの統合・寿命
  mergeDistanceKm: 40,             // これより近い2つのイベントは統合する
  eventDurationBaseMs: 45_000,     // イベントの基本持続時間(ms)
  eventDurationPerLevelMs: 15_000, // レベルに応じて延びる持続時間(ms) x level
};

// 2点間の距離(km, 簡易haversine)
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 震度相当値(連続値) → イベントレベル(0〜4)。
export function intensityToShakeLevel(intensity, levelThresholds = DEFAULT_SHAKE_DETECTION_PARAMS.levelThresholds) {
  for (let level = levelThresholds.length; level >= 1; level--) {
    if (intensity >= levelThresholds[level - 1]) return level;
  }
  return 0;
}

let eventIdSeq = 1;

function createEvent(now) {
  return {
    id: eventIdSeq++,
    level: 0,
    pointIds: new Set(),
    pointCount: 0,
    minLat: null, maxLat: null, minLon: null, maxLon: null,
    centerLat: null, centerLon: null,
    confirmed: false,
    createdAt: now,
    updatedAt: now,
    expireAt: now,
  };
}

function addPointToEvent(event, point, level, now, params) {
  if (level > event.level) event.level = level;
  if (!event.pointIds.has(point.id)) {
    event.pointIds.add(point.id);
    event.pointCount = event.pointIds.size;
  }
  event.minLat = event.minLat == null ? point.lat : Math.min(event.minLat, point.lat);
  event.maxLat = event.maxLat == null ? point.lat : Math.max(event.maxLat, point.lat);
  event.minLon = event.minLon == null ? point.lon : Math.min(event.minLon, point.lon);
  event.maxLon = event.maxLon == null ? point.lon : Math.max(event.maxLon, point.lon);
  event.centerLat = (event.minLat + event.maxLat) / 2;
  event.centerLon = (event.minLon + event.maxLon) / 2;
  event.updatedAt = now;
  event.expireAt = now + params.eventDurationBaseMs + event.level * params.eventDurationPerLevelMs;
  point.eventId = event.id;
  // 2点以上揃った時点で即確定(孤立トリガーは呼び出し側で個別に確定させる)。
  // 「近傍2点がほぼ同時に急上昇した」こと自体が、旧実装のスコア閾値より
  // 強いノイズ耐性を持つため、多数の観測点が揃うのを待つ必要がない。
  if (!event.confirmed && event.pointCount >= 2) event.confirmed = true;
}

function mergeEventInto(target, other) {
  for (const id of other.pointIds) target.pointIds.add(id);
  target.pointCount = target.pointIds.size;
  if (other.level > target.level) target.level = other.level;
  if (other.minLat != null) {
    target.minLat = target.minLat == null ? other.minLat : Math.min(target.minLat, other.minLat);
    target.maxLat = target.maxLat == null ? other.maxLat : Math.max(target.maxLat, other.maxLat);
    target.minLon = target.minLon == null ? other.minLon : Math.min(target.minLon, other.minLon);
    target.maxLon = target.maxLon == null ? other.maxLon : Math.max(target.maxLon, other.maxLon);
  }
  if (target.minLat != null) {
    target.centerLat = (target.minLat + target.maxLat) / 2;
    target.centerLon = (target.minLon + target.maxLon) / 2;
  }
  target.confirmed = target.confirmed || other.confirmed || target.pointCount >= 2;
  target.updatedAt = Math.max(target.updatedAt, other.updatedAt);
  target.expireAt = Math.max(target.expireAt, other.expireAt);
}

/**
 * 揺れ検知エンジン本体。観測点マスタが揃ったら initialize() を一度呼び、
 * 以降はデータ更新のたびに processTick() を呼ぶ。
 */
export class ShakeDetectionEngine {
  constructor(params = {}) {
    this.params = { ...DEFAULT_SHAKE_DETECTION_PARAMS, ...params };
    this.points = new Map();   // id -> pointState
    this.events = new Map();   // id -> event
    this.tickIndex = 0;        // corroborationWindowTicksの基準となる、tickの通し番号
    this.initialized = false;
  }

  // 観測点の位置情報から近傍点リストを事前計算する(SetupNearPoints相当)。
  // 観測点マスタが変わった時だけ呼び直せばよい(毎tick呼ぶ必要はない)。
  initialize(stations) {
    const { neighborRadiusKm, maxNeighbors } = this.params;
    const prevPoints = this.points;
    this.points = new Map();
    for (const s of stations) {
      const prev = prevPoints.get(s.id);
      this.points.set(s.id, {
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        prevIntensity: prev ? prev.prevIntensity : null,
        latestIntensity: prev ? prev.latestIntensity : null,
        intensityDiff: 0,
        lastRiseTick: prev ? prev.lastRiseTick : null,
        pendingSince: prev ? prev.pendingSince : null,
        eventId: prev ? prev.eventId : null,
        nearPoints: [],
      });
    }
    for (const s of stations) {
      const point = this.points.get(s.id);
      const candidates = [];
      for (const other of stations) {
        if (other.id === s.id) continue;
        const dist = haversineKm(s.lat, s.lon, other.lat, other.lon);
        if (dist > neighborRadiusKm) continue;
        candidates.push({ id: other.id, distanceKm: dist });
      }
      candidates.sort((a, b) => a.distanceKm - b.distanceKm);
      point.nearPoints = candidates.slice(0, maxNeighbors);
    }
    this.initialized = true;
  }

  // 1回分のデータ更新を処理し、現在のイベント一覧(確定/未確定含む)を返す。
  // valuesMap: Map<観測点id, 震度相当値>。データが無い観測点はキーごと無し。
  processTick(valuesMap, now = Date.now()) {
    const { params, points } = this;
    if (!this.initialized) return [];
    this.tickIndex += 1;
    const tick = this.tickIndex;

    // 1) 値の更新。履歴は「直前の値」だけで足りる(平均を取らないため)。
    for (const point of points.values()) {
      const value = valuesMap.has(point.id) ? valuesMap.get(point.id) : null;
      point.prevIntensity = point.latestIntensity;
      point.latestIntensity = value;
      point.intensityDiff = (value != null && point.prevIntensity != null) ? value - point.prevIntensity : 0;
    }

    // 2) 急上昇の判定。このtickで上がった観測点にtick番号を刻んでおく
    //    (corroborationWindowTicksでの「同時」判定の基準になる)。
    for (const point of points.values()) {
      if (point.latestIntensity != null && point.intensityDiff >= params.riseThreshold) {
        point.lastRiseTick = tick;
      }
    }

    // 3) 同時多発判定 → イベント割当。履歴平均・スコア積み上げを挟まず、
    //    このtickで急上昇した点についてその場で判定する。
    for (const point of points.values()) {
      if (point.lastRiseTick !== tick) continue;

      if (point.eventId != null) {
        // 既存イベントに属している点は、レベル・寿命を更新するだけ。
        const event = this.events.get(point.eventId);
        if (event) {
          const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
          addPointToEvent(event, point, level, now, params);
        }
        point.pendingSince = null;
        continue;
      }

      // 近傍のうち、直近corroborationWindowTicks以内に急上昇していた点を探す。
      const corroborators = [];
      for (const np of point.nearPoints) {
        const neighbor = points.get(np.id);
        if (!neighbor || neighbor.lastRiseTick == null) continue;
        if (tick - neighbor.lastRiseTick <= params.corroborationWindowTicks) corroborators.push(neighbor);
      }

      const isolated = point.nearPoints.length === 0;
      const triggered = isolated
        ? point.intensityDiff >= params.isolatedRiseThreshold
        : corroborators.length > 0;

      if (!triggered) {
        // まだ裏付けが無い → pending状態にして次tick以降の裏付けを待つ。
        if (point.pendingSince == null) point.pendingSince = tick;
        continue;
      }
      point.pendingSince = null;

      // 裏付けとなった近傍点(既にイベントに属していれば合流)を集約する。
      const relatedEventIds = new Set();
      for (const c of corroborators) if (c.eventId != null) relatedEventIds.add(c.eventId);
      const relatedEvents = [...relatedEventIds].map(id => this.events.get(id)).filter(Boolean);

      let targetEvent;
      if (relatedEvents.length > 1) {
        relatedEvents.sort((a, b) => a.createdAt - b.createdAt);
        targetEvent = relatedEvents[0];
        for (const other of relatedEvents.slice(1)) {
          if (other.id === targetEvent.id) continue;
          mergeEventInto(targetEvent, other);
          this.events.delete(other.id);
        }
      } else if (relatedEvents.length === 1) {
        targetEvent = relatedEvents[0];
      } else {
        targetEvent = createEvent(now);
        this.events.set(targetEvent.id, targetEvent);
      }

      const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
      addPointToEvent(targetEvent, point, level, now, params);

      // 裏付けに使った近傍点も同じイベントに合流させる(未所属なら新規参加)。
      for (const c of corroborators) {
        if (c.eventId != null && c.eventId !== targetEvent.id) continue; // 別イベントは上で統合済み
        const cLevel = intensityToShakeLevel(c.latestIntensity ?? point.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, c, cLevel, now, params);
      }

      // 孤立トリガー(近傍なしで単独発火)は、単独でも高いしきい値を越えて
      // いるため、待たずにそのまま確定扱いにする。
      if (isolated) targetEvent.confirmed = true;
    }

    // 4) pendingのまま長く裏付けを得られない点は静かに諦める(誤報にしない)。
    for (const point of points.values()) {
      if (point.pendingSince != null && tick - point.pendingSince > params.pendingExpireTicks) {
        point.pendingSince = null;
      }
    }

    // 5) 距離が近いイベント同士の統合(同一現象が複数イベントに分かれるのを防ぐ)
    const eventList = [...this.events.values()];
    for (let i = 0; i < eventList.length; i++) {
      const a = eventList[i];
      if (!this.events.has(a.id) || a.centerLat == null) continue;
      for (let j = i + 1; j < eventList.length; j++) {
        const b = eventList[j];
        if (!this.events.has(b.id) || b.centerLat == null) continue;
        const dist = haversineKm(a.centerLat, a.centerLon, b.centerLat, b.centerLon);
        if (dist <= params.mergeDistanceKm) {
          mergeEventInto(a, b);
          this.events.delete(b.id);
        }
      }
    }

    // 6) 期限切れイベントの削除
    for (const [id, event] of this.events) {
      if (event.expireAt < now) this.events.delete(id);
    }

    return [...this.events.values()]
      .filter(e => e.centerLat != null)
      .map(e => ({ ...e, pointIds: [...e.pointIds] }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
