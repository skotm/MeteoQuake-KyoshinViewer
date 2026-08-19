/**
 * shakeDetection.ts
 * ------------------------------------------------------------
 * KyoshinEewViewer (ingen084/KyoshinEewViewerIngen) の ShakeDetectionEngine.cs
 * を参考にした、リアルタイム震度観測点データからの揺れ検知エンジン。
 *
 * 参考: https://github.com/ingen084/KyoshinEewViewerIngen/blob/0.21.14/
 *       src/KyoshinEewViewer.Core/ShakeDetection/ShakeDetectionEngine.cs
 * (このファイルはユーザー提供のアルゴリズムまとめ shake_detection_summary.md
 *  を元に、独自にJS/TS移植したもの。元実装のコードそのものではない)
 *
 * 元実装は地図画像のピクセル強度から観測点の値を都度計算するが(ProcessImage)、
 * このアプリはAPIから観測点ごとの震度相当値(realtimeValues)を直接受信して
 * いるため、画像処理に相当する部分は不要。近傍点の作成(SetupNearPoints)・
 * 異常値除外・近傍重み付きスコア計算・イベント生成/統合/確定のロジックのみを
 * 移植している。
 *
 * パラメータ(DEFAULT_SHAKE_DETECTION_PARAMS)は元実装の既定値ではなく仮の値。
 * 実データを見ながら調整すること。
 */

export const DEFAULT_SHAKE_DETECTION_PARAMS = {
  // 近傍点探索(SetupNearPoints相当)
  maxSearchDistanceKm: 30,     // 近傍とみなす距離の上限(km)
  maxNearPoints: 8,            // 近傍点として採用する最大数

  // 検出条件
  minDetectionDiff: 0.5,       // 検出対象とする最小の震度上昇量
  isolatedThreshold: 1.5,      // 近傍の有効重み合計がこれ未満なら「孤立(離島等)」扱い
  isolatedDetectionDiff: 1.0,  // 孤立点が単独でイベント生成するのに必要な上昇量
  scoreIntensityOffset: 0.3,   // 近傍差分から差し引くオフセット
  noChangePenaltyFactor: 0.3,  // 無反応の近傍点に課すペナルティ係数
  scoreThresholdRatio: 0.4,    // 有効重み合計に掛ける検出閾値の比率

  // 異常値(スパイク)除外
  spikeSmallDiff: 1.0,         // これ未満の変化量を「変化小」とみなす
  spikeCloseToAverageDiff: 1.0,// 短期平均との差がこれ以下なら「平均に近い」とみなす
  spikeNeighborDiffMin: 3.0,   // 近傍全点よりこれ以上高ければスパイク濃厚

  // イベント確定(UpdateEventConfirmation相当。レベルは0〜4の5段階)
  weakerConfirmPointCount: 4,  // レベル1以下(弱め)で確定に必要な観測点数
  weakConfirmPointCount: 2,    // レベル2(弱)で確定に必要な観測点数
  // レベル3以上は即確定

  // イベントのマージ・寿命
  mergeDistanceKm: 40,             // これより近い2つのイベントは統合する
  eventDurationBaseMs: 60_000,     // イベントの基本持続時間(ms)
  eventDurationPerLevelMs: 15_000, // レベルに応じて延びる持続時間(ms) x level
  historyLength: 6,                // 短期平均に使う履歴の保持tick数
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

// 震度相当値(連続値)→ イベントレベル(0〜4)への簡易割り当て。
// 元実装のLevel(Weaker/Weak/Medium/Strong/Severe相当)を、このアプリの
// 連続震度スケール(shindoColorScale.ts、-3.0〜7.0)に合わせて割り当てたもの。
export function intensityToShakeLevel(intensity) {
  if (intensity >= 5.0) return 4;
  if (intensity >= 3.5) return 3;
  if (intensity >= 2.0) return 2;
  if (intensity >= 0.5) return 1;
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
  target.confirmed = target.confirmed || other.confirmed;
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
    this.initialized = false;
  }

  // 観測点の位置情報から近傍点リストを事前計算する(SetupNearPoints相当)。
  // 観測点マスタが変わった時だけ呼び直せばよい(毎tick呼ぶ必要はない)。
  initialize(stations) {
    const { maxSearchDistanceKm, maxNearPoints } = this.params;
    const prevPoints = this.points;
    this.points = new Map();
    for (const s of stations) {
      const prev = prevPoints.get(s.id);
      this.points.set(s.id, {
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        history: prev ? prev.history : [],
        latestIntensity: prev ? prev.latestIntensity : null,
        prevIntensity: prev ? prev.prevIntensity : null,
        intensityDiff: 0,
        isTmpDisabled: false,
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
        if (dist > maxSearchDistanceKm) continue;
        candidates.push({ id: other.id, distance: dist });
      }
      candidates.sort((a, b) => a.distance - b.distance);
      point.nearPoints = candidates.slice(0, maxNearPoints).map(c => ({
        id: c.id,
        weight: Math.max(0, 1 - c.distance / maxSearchDistanceKm),
      }));
    }
    this.initialized = true;
  }

  // 1回分のデータ更新を処理し、現在のイベント一覧(確定/未確定含む)を返す。
  // valuesMap: Map<観測点id, 震度相当値>。データが無い観測点はキーごと無し。
  processTick(valuesMap, now = Date.now()) {
    const { params, points } = this;
    if (!this.initialized) return [];

    // 1) 各観測点の履歴・差分を更新する。
    for (const point of points.values()) {
      const value = valuesMap.has(point.id) ? valuesMap.get(point.id) : null;
      if (value == null) {
        point.prevIntensity = point.latestIntensity;
        point.latestIntensity = null;
        point.intensityDiff = 0;
        continue;
      }
      point.prevIntensity = point.latestIntensity;
      point.latestIntensity = value;
      point.intensityDiff = point.prevIntensity != null ? value - point.prevIntensity : 0;
      point.history.push(value);
      if (point.history.length > params.historyLength) point.history.shift();
    }

    // 2) 異常値(スパイク)除外。単独の突出値を一時的に検出対象から外す。
    for (const point of points.values()) {
      if (point.latestIntensity == null) { point.isTmpDisabled = false; continue; }
      const avg = point.history.length > 0
        ? point.history.reduce((a, b) => a + b, 0) / point.history.length
        : point.latestIntensity;
      const hasNear = point.nearPoints.length > 0;
      const baseThreshold = hasNear ? 3 : 5;
      const smallDiff = point.intensityDiff < params.spikeSmallDiff && point.eventId == null;
      const highEnough = point.latestIntensity >= baseThreshold;
      const closeToAverage = Math.abs(avg - point.latestIntensity) <= params.spikeCloseToAverageDiff;

      let farFromAllNeighbors = hasNear;
      for (const np of point.nearPoints) {
        const neighbor = points.get(np.id);
        if (!neighbor || neighbor.latestIntensity == null) { farFromAllNeighbors = false; break; }
        if (point.latestIntensity - neighbor.latestIntensity < params.spikeNeighborDiffMin) { farFromAllNeighbors = false; break; }
      }

      point.isTmpDisabled = smallDiff && highEnough && closeToAverage && (point.isTmpDisabled || farFromAllNeighbors);
    }

    // 3) 検出処理(早期スキップ・スコア計算・イベント割当)
    for (const point of points.values()) {
      if (point.latestIntensity == null) continue;
      if (point.isTmpDisabled) continue;
      if (point.intensityDiff < params.minDetectionDiff) continue;

      // 近傍の有効重み合計
      let availableTotalWeight = 0;
      for (const np of point.nearPoints) {
        const neighbor = points.get(np.id);
        if (neighbor && neighbor.latestIntensity != null) availableTotalWeight += np.weight;
      }

      let passed = false;
      const relatedEventIds = new Set();
      if (point.eventId != null) relatedEventIds.add(point.eventId);

      if (availableTotalWeight < params.isolatedThreshold) {
        // 孤立(離島等)判定 — 単独でも一定以上の上昇があれば検出する
        passed = point.intensityDiff >= params.isolatedDetectionDiff;
      } else {
        // 近傍重み付きスコア計算
        let score = 0;
        let penaltyScore = 0;
        let contributingPointCount = 0;

        for (const np of point.nearPoints) {
          const neighbor = points.get(np.id);
          if (!neighbor || neighbor.isTmpDisabled || neighbor.latestIntensity == null) continue;
          if (neighbor.intensityDiff >= params.minDetectionDiff) {
            score += np.weight * (neighbor.intensityDiff - params.scoreIntensityOffset);
            contributingPointCount++;
            if (neighbor.eventId != null) relatedEventIds.add(neighbor.eventId);
          } else {
            penaltyScore += np.weight * params.noChangePenaltyFactor;
          }
        }
        const finalScore = score - penaltyScore;
        const threshold = availableTotalWeight * params.scoreThresholdRatio;

        // 単独寄与はノイズの可能性があるため、2点以上の裏付けを必須にする
        passed = contributingPointCount > 1 && finalScore >= threshold;
      }

      if (!passed) continue;

      // イベント割当(新規作成/既存への追加/複数イベントの統合)
      const level = intensityToShakeLevel(point.latestIntensity);
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

      addPointToEvent(targetEvent, point, level, now, params);
    }

    // 4) 距離が近いイベント同士の統合(同一現象が複数イベントに分かれるのを防ぐ)
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

    // 5) 確定ルール(UpdateEventConfirmation相当)
    for (const event of this.events.values()) {
      if (event.confirmed) continue;
      if (event.level <= 1) {
        if (event.pointCount > params.weakerConfirmPointCount) event.confirmed = true;
      } else if (event.level === 2) {
        if (event.pointCount > params.weakConfirmPointCount) event.confirmed = true;
      } else {
        event.confirmed = true;
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
