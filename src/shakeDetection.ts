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
 * 震度0以上の通常検知については、その後さらに精度を上げるため、「近傍の
 * うち任意の1点が時間窓内に一致すればOK」という判定から、「近い順にN点中
 * K点以上が条件を満たす」という統計的に頑健な方式に置き換えた。さらに、
 * 1つの万能な式に頼らず、自点の現在値・自点の直近10秒間の上昇速度最大値・
 * 近傍の現在値・近傍の直近10秒間の上昇速度最大値、を組み合わせた複数の
 * ルール(detectionRules)を用意し、そのいずれか1つでも満たせば検知とする
 * (ごり押し型のアンサンブル。1つの型の地震だけでなく、急激/緩やか・
 * 局所/広域など複数のパターンを別々のルールで拾う狙い)。
 *
 * ただし瞬時diffだけでは、観測点固有の単発センサーノイズ(1tickだけ跳ねて
 * すぐ戻る揺らぎ)を拾って誤検知することがあったため、直近5秒平均(1Hz
 * 更新想定でhistoryLength=5tick)を「その観測点の落ち着いた基準値」として
 * 追加で参照し、そこから見ても十分上回っている場合のみ「急上昇」と認める
 * ようにしている。平均を待つと言っても直近5秒分の軽い参照でしかないため、
 * 検知の速さへの影響は最小限に抑えている。
 *
 * さらに、震度microChainIntensityCeiling(既定-1)未満のごく微小な変化に
 * ついては、上記の「近傍が同時期に急上昇」判定の代わりに、P波の伝播速度に
 * 基づく連鎖検知を使う。観測点間の距離と検出時刻の差から伝播速度を逆算し、
 * それが物理的に妥当な範囲(shakeTestSimulation.tsのP波速度6.8km/s前後)で
 * あれば地震波の可能性が高いとみなす。ただし2点だけの速度一致は偶然のことも
 * あるため、3点以上(A→B→C)の連鎖で速度の一貫性が取れて初めて検知として
 * 採用する。
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
  maxNeighbors: 8,             // 近傍点として保持する最大数(detectionRulesで
                                // 最大8点まで参照するルールがあるため)

  // トリガー条件(1tickごとの即時判定+短期平均によるノイズ除去)
  riseThreshold: 0.5,          // 前tickからの上昇量がこれ以上で「急上昇」とみなす
  isolatedRiseThreshold: 1.2,  // 近傍が無い孤立点が単独トリガーするための上昇量(離島等)

  // 直近5秒平均によるノイズ除去。前tickとの比較だけだと、観測点固有の
  // 単発センサーノイズ(1tickだけ跳ねてすぐ戻るような揺らぎ)でも
  // riseThresholdを超えてしまうことがある。実データは1秒間隔で更新される
  // 前提で、直近5tick(=5秒)の平均を「その観測点の落ち着いた基準値」とみなし、
  // そこから見ても十分上回っていることを追加で要求することで誤検知を減らす。
  historyLength: 5,             // 平均に使う直近tick数(1Hz想定で5秒分)
  avgRiseThreshold: 0.4,        // 直近5秒平均からの上昇量がこれ以上必要
  isolatedAvgRiseThreshold: 1.0, // 孤立点の場合の、直近5秒平均からの上昇量の要求値

  // 直近10秒間の「上昇速度(1tickごとのdiff)」の最大値。ピークが少し前の
  // tickにあり、現在tickでは横ばい・微減していても拾えるようにするための
  // 判定材料(detectionRulesで使う)。
  riseRateHistoryLength: 10,   // 上昇速度の最大値を見る際の窓(1Hz想定で10秒分)

  // 近傍の裏付け判定(N点中K点以上)+複数ルールのアンサンブル。
  // 「近傍のうち任意の1点が時間窓内に急上昇していればOK」という判定は
  // 単一の近傍ノイズに引っ張られやすいため廃止し、「近い順にN点中K点以上が
  // 条件を満たす」という統計的に頑健な方式に置き換える。さらに、1つの
  // 万能な式ではなく、複数の観点(自点の現在値・自点の10秒最大上昇速度・
  // 近傍の現在値・近傍の10秒最大上昇速度)を組み合わせたルールをいくつか
  // 用意し、どれか1つでも満たせば検知とする(ごり押し型のアンサンブル)。
  // 弱い揺れを拾うルールほど、その分近傍の裏付け本数を厚くすることで、
  // 誤検知を増やさずに検知感度を上げている。
  // 震度0未満の点・孤立点(近傍なし)には適用しない(それぞれ別経路で判定)。
  detectionRules: [
    {
      // 強い揺れ・即応型: 自点が明確に上がっていて、近傍7点中2点も
      // 直近10秒で明確な上昇速度を記録していれば検知。
      minOwnIntensity: 1.0,
      minOwnRiseRateMax10s: 1.0,
      neighborCount: 7,
      requiredNeighborCount: 2,
      neighborMetric: "riseRateMax10s",
      minNeighborValue: 0.2,
    },
    {
      // 中程度・広域型: そこまで急激でなくても、近傍3点中2点が既に
      // ある程度の震度に達していれば検知。
      minOwnIntensity: 0.5,
      minOwnRiseRateMax10s: null,
      neighborCount: 3,
      requiredNeighborCount: 2,
      neighborMetric: "intensity",
      minNeighborValue: 1.0,
    },
    {
      // 急上昇・少数近傍即応型: 自点の上昇速度がそこそこ大きければ、
      // 近傍4点中1点の裏付けだけで速く検知する(速さ優先)。
      minOwnIntensity: 0.3,
      minOwnRiseRateMax10s: 0.6,
      neighborCount: 4,
      requiredNeighborCount: 1,
      neighborMetric: "riseRateMax10s",
      minNeighborValue: 0.3,
    },
    {
      // 広域同時多発型: 1点1点は弱くても、近傍8点中3点で同時に
      // 上がっていれば、広範囲の揺れとして検知する。
      minOwnIntensity: 0.2,
      minOwnRiseRateMax10s: 0.3,
      neighborCount: 8,
      requiredNeighborCount: 3,
      neighborMetric: "intensity",
      minNeighborValue: 0.2,
    },
    {
      // 微小地震・弱い揺れ専用型: 自点の条件は他ルールより大幅に緩めるが、
      // その分、近傍8点中5点(過半数)という厚い裏付けを要求することで
      // 誤検知の増加を抑える(単独の観測点ノイズでは近傍の過半数が
      // 同時に反応することはまず無いため)。
      minOwnIntensity: 0.1,
      minOwnRiseRateMax10s: 0.15,
      neighborCount: 8,
      requiredNeighborCount: 5,
      neighborMetric: "intensity",
      minNeighborValue: 0.1,
    },
  ],

  // 未確定(pending)状態の保持。震度0以上・近傍ありの通常検知は
  // detectionRulesに近傍の裏付けが組み込まれているためpendingを使わない。
  // 孤立点(単独トリガー)のみ、この仕組みで裏付け待ちを扱う。
  pendingExpireTicks: 3,       // 単独で急上昇した点が、これだけtickが経っても
                                // どの近傍からも裏付けを得られなければ静かに諦める

  // 震度0未満の微小変化専用の検知経路(P波伝播速度チェック)。
  // riseThresholdには届かない微小な上昇でも、近傍点への伝播が、距離と
  // 時間差から逆算した速度としてP波の妥当な速度レンジに収まっていれば
  // 地震波の可能性が高いとみなす。ただし2点だけの速度一致は偶然の
  // 可能性があるため、3点以上の連鎖(A→B→C)で速度の一貫性が取れて
  // 初めて検知として採用する。この経路は「microChainIntensityCeiling未満」
  // の範囲でのみ、detectionRulesによる判定の代わりに使う
  // (その値以上の通常の急上昇検知には影響しない)。
  microChainIntensityCeiling: -1, // この値未満を「微小な変化」として
                                    // 伝播速度連鎖経路の対象にする境界値
  tickIntervalSeconds: 1,      // 1tickが何秒に相当するか(実データの更新間隔)
  microRiseThreshold: 0.12,    // 対象範囲の観測点で、これ以上の上昇があれば
                                // 「微小上昇」候補とする(riseThresholdより緩い)
  microAvgRiseThreshold: 0.1,  // 直近5秒平均からの上昇量の要求値(微小版)
  pWaveMinSpeedKmS: 5.5,       // 伝播速度として妥当とみなす下限(km/s)
  pWaveMaxSpeedKmS: 8.0,       // 伝播速度として妥当とみなす上限(km/s)
                                // (shakeTestSimulation.tsのP波速度6.8km/sを中心に許容幅を持たせた値)
  microChainMinLength: 3,      // 検知として採用するために必要な連鎖の点数

  // 面的拡張(BFS)。裏付けが取れて確定した点を核に、そこから緩い基準で
  // 近傍へ広げる(eq_detection.jsの「核は厳しく・拡張は緩く」を参考)。
  propagationRiseThreshold: 0.15, // これ以上の上昇があれば、単独では検知の
                                   // 裏付けにならなくても既存イベントへの
                                   // 取り込み(拡張)は許可する
  propagationMaxRadiusKm: 60,     // イベントの発生起点(最初に加わった点)から
                                   // これより離れた点へは拡張しない。上限が
                                   // 無いと、途中の弱いノイズや別の遠方の揺れを
                                   // 挟んで領域が際限なく膨らみ、本来無関係な
                                   // 別イベントと誤って統合されてしまうため。

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

// 2つのバウンディングボックス(イベントの領域)間の最短距離(km)を概算する。
// イベント同士の統合判定に、中心点同士の距離ではなくこちらを使う。広範囲に
// 及ぶ揺れでは、各イベントの領域(バウンディングボックス)は隣接していても
// 中心点同士は離れていることが多く、中心点だけで判定すると統合されずに
// 小さなイベントが乱立してしまうため。
function rectMinDistanceKm(a, b) {
  const dLat = Math.max(0, a.minLat - b.maxLat, b.minLat - a.maxLat);
  const midLat = (a.centerLat + b.centerLat) / 2;
  const kmPerLon = 111 * Math.max(0.1, Math.cos(midLat * Math.PI / 180));
  const dLon = Math.max(0, a.minLon - b.maxLon, b.minLon - a.maxLon) * kmPerLon;
  const kmLat = dLat * 111;
  return Math.sqrt(kmLat * kmLat + dLon * dLon);
}

// 震度相当値(連続値) → イベントレベル(0〜4)。
export function intensityToShakeLevel(intensity, levelThresholds = DEFAULT_SHAKE_DETECTION_PARAMS.levelThresholds) {
  for (let level = levelThresholds.length; level >= 1; level--) {
    if (intensity >= levelThresholds[level - 1]) return level;
  }
  return 0;
}

// 直近履歴(historyに積んだ過去の値)の単純平均。履歴が無ければnull。
function computeBaselineAvg(history) {
  if (history.length === 0) return null;
  let sum = 0;
  for (const v of history) sum += v;
  return sum / history.length;
}

// 連鎖(microChainFromIdのリンク)を辿って、targetIdが含まれているかを調べる。
// A→B→A のような循環リンクができるのを未然に防ぐために使う
// (循環ができると連鎖を辿る処理が無限ループしてクラッシュするため)。
// maxStepsは無限ループの安全弁(既に壊れたデータが紛れ込んでいても止まる)。
function chainContainsId(startPoint, targetId, points, maxSteps) {
  let cursor = startPoint;
  let steps = 0;
  while (cursor && steps < maxSteps) {
    if (cursor.id === targetId) return true;
    cursor = cursor.microChainFromId != null ? points.get(cursor.microChainFromId) : null;
    steps++;
  }
  return false;
}

// detectionRulesのいずれかを満たすか判定する。満たした最初のルールについて、
// 条件を満たした近傍点(matchedNeighbors)も返す(イベントへの合流に使う)。
function evaluateDetectionRules(point, points, rules) {
  for (const rule of rules) {
    if (rule.minOwnIntensity != null && point.latestIntensity < rule.minOwnIntensity) continue;
    if (rule.minOwnRiseRateMax10s != null) {
      if (point.riseRateMax10s == null || point.riseRateMax10s < rule.minOwnRiseRateMax10s) continue;
    }

    const candidates = point.nearPoints.slice(0, rule.neighborCount);
    const matchedNeighbors = [];
    for (const np of candidates) {
      const neighbor = points.get(np.id);
      if (!neighbor) continue;
      const neighborValue = rule.neighborMetric === "riseRateMax10s" ? neighbor.riseRateMax10s : neighbor.latestIntensity;
      if (neighborValue != null && neighborValue >= rule.minNeighborValue) matchedNeighbors.push(neighbor);
    }

    if (matchedNeighbors.length >= rule.requiredNeighborCount) {
      return { matched: true, matchedNeighbors };
    }
  }
  return { matched: false, matchedNeighbors: [] };
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
    originLat: null, originLon: null, // 最初にこのイベントへ加わった点の座標(不変)。
                                        // BFS面的拡張がここからどれだけ離れて良いかの基準にする。
    // 観測点ごとの「最初にこのイベントへ加わった実時刻」。epicenterEstimation.ts
    // の震源推定(検知時刻ベースの走時解析)専用のデータで、検知アルゴリズム
    // 自体はこの値を参照しない。id -> { lat, lon, detectedAt }
    detectionTimes: new Map(),
    confirmed: false,
    createdAt: now,
    updatedAt: now,
    expireAt: now,
  };
}

function addPointToEvent(event, point, level, now, params) {
  if (level > event.level) event.level = level;
  if (event.originLat == null) {
    event.originLat = point.lat;
    event.originLon = point.lon;
  }
  if (!event.pointIds.has(point.id)) {
    event.pointIds.add(point.id);
    event.pointCount = event.pointIds.size;
  }
  // 震源推定用に、この観測点が最初にイベントへ加わった時刻・その時点の震度
  // 相当値(level)を記録する(2回目以降の呼び出しでは上書きしない = あくまで
  // 「最初に検知した時刻・その時の震度」。揺れの広がり方(震度の減衰パターン)・
  // 方向を震源推定に使う際、震度が最も高い観測点ほど震源に近いはず、という
  // 手がかりに使う)。
  if (!event.detectionTimes.has(point.id)) {
    event.detectionTimes.set(point.id, { lat: point.lat, lon: point.lon, detectedAt: now, level });
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
  // detectionTimesも合流させる(既にtargetに記録がある点はそちらを優先=
  // より早い/先に統合された側の記録を残す。通常はほぼ同時なので影響は軽微)。
  for (const [id, d] of other.detectionTimes) {
    if (!target.detectionTimes.has(id)) target.detectionTimes.set(id, d);
  }
  if (other.level > target.level) target.level = other.level;
  if (target.originLat == null) {
    target.originLat = other.originLat;
    target.originLon = other.originLon;
  }
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

// 海底観測点(id 5000以上、S-net等)かどうかの判定。App.tsx側の「揺れ上昇中
// 判定の対象外」という既存の扱いと同じ基準を踏襲している。
function isOceanBottomStationId(id) {
  const idNum = Number(id);
  return Number.isFinite(idNum) && idNum >= 5000;
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
    this.tickIndex = 0;        // lastRiseTick等の基準となる、tickの通し番号
    this.initialized = false;
  }

  // 観測点の位置情報から近傍点リストを事前計算する(SetupNearPoints相当)。
  // 観測点マスタが変わった時だけ呼び直せばよい(毎tick呼ぶ必要はない)。
  initialize(stations) {
    const { neighborRadiusKm, maxNeighbors } = this.params;
    // 海底観測点(id 5000以上、S-net等)は検知の対象外とする。マスタの時点で
    // 除外しておくことで、自身がトリガーになることはもちろん、他の観測点の
    // 近傍裏付けとして使われることも無くなる。
    const targetStations = stations.filter((s) => !isOceanBottomStationId(s.id));
    const prevPoints = this.points;
    this.points = new Map();
    for (const s of targetStations) {
      const prev = prevPoints.get(s.id);
      this.points.set(s.id, {
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        prevIntensity: prev ? prev.prevIntensity : null,
        latestIntensity: prev ? prev.latestIntensity : null,
        intensityDiff: 0,
        history: prev ? prev.history : [], // 直近historyLength件の値(5秒平均の元データ)
        avgDiff: prev ? prev.avgDiff : null,
        riseRateHistory: prev ? prev.riseRateHistory : [], // 直近riseRateHistoryLength件の上昇速度(diff)
        riseRateMax10s: prev ? prev.riseRateMax10s : null,  // その最大値
        lastRiseTick: prev ? prev.lastRiseTick : null,
        // 震度0未満の微小変化の伝播速度連鎖(A→B→C)用の状態。
        lastMicroRiseTick: prev ? prev.lastMicroRiseTick : null,
        microChainFromId: prev ? prev.microChainFromId : null, // 連鎖の1つ前の観測点id
        microChainLength: prev ? prev.microChainLength : 0,     // その点で終わる連鎖の長さ
        pendingSince: prev ? prev.pendingSince : null,
        eventId: prev ? prev.eventId : null,
        nearPoints: [],
      });
    }
    for (const s of targetStations) {
      const point = this.points.get(s.id);
      const candidates = [];
      for (const other of targetStations) {
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

    // 1) 値の更新。上昇量は「前tickとの差」に加えて「直近5秒平均との差」も
    //    使うため、上書きする前の値をhistoryに積んでおく。あわせて、直近
    //    10秒間の「上昇速度(diff)」の最大値も更新する(detectionRulesで使用)。
    for (const point of points.values()) {
      const value = valuesMap.has(point.id) ? valuesMap.get(point.id) : null;
      if (point.latestIntensity != null) {
        point.history.push(point.latestIntensity);
        if (point.history.length > params.historyLength) point.history.shift();
      }
      point.prevIntensity = point.latestIntensity;
      point.latestIntensity = value;
      point.intensityDiff = (value != null && point.prevIntensity != null) ? value - point.prevIntensity : 0;
      const baselineAvg = value != null ? computeBaselineAvg(point.history) : null;
      point.avgDiff = baselineAvg != null ? value - baselineAvg : null;

      point.riseRateHistory.push(point.intensityDiff);
      if (point.riseRateHistory.length > params.riseRateHistoryLength) point.riseRateHistory.shift();
      point.riseRateMax10s = point.riseRateHistory.length > 0 ? Math.max(...point.riseRateHistory) : null;
    }

    // 2) 急上昇の判定。このtickで上がった観測点にtick番号を刻んでおく
    //    (孤立点のisolatedRiseThreshold判定で使う。非孤立点はdetectionRules
    //    で判定するため、ここでのマーキング自体は使わない)。
    //    前tickとの差(瞬時diff)に加えて、直近5秒平均からの差も一定以上
    //    無ければ「急上昇」とは認めない(単発ノイズの弾き)。ただし観測点が
    //    復帰直後などで履歴がまだ無い(avgDiff == null)場合は、検知が
    //    遅れないよう瞬時diffのみで判定する。
    for (const point of points.values()) {
      if (point.latestIntensity == null) continue;
      const instantRise = point.intensityDiff >= params.riseThreshold;
      const avgRise = point.avgDiff == null || point.avgDiff >= params.avgRiseThreshold;
      if (instantRise && avgRise) {
        point.lastRiseTick = tick;
      }
    }

    // 3) 震度0未満の微小変化専用: P波伝播速度に基づく連鎖検知。
    //    riseThresholdには届かない微小な上昇でも、近傍点へ物理的に妥当な
    //    速度(pWaveMinSpeedKmS〜pWaveMaxSpeedKmS)で伝播していれば地震波の
    //    可能性が高い。2点だけの速度一致は偶然の可能性があるため、
    //    3点以上(A→B→C)で速度の一貫性が取れた連鎖のみ検知として採用する。
    for (const point of points.values()) {
      if (point.latestIntensity == null || point.latestIntensity >= params.microChainIntensityCeiling) continue;
      const microRise = point.intensityDiff >= params.microRiseThreshold
        && (point.avgDiff == null || point.avgDiff >= params.microAvgRiseThreshold);
      if (!microRise) continue;

      // 近傍のうち、物理的に妥当な速度で先に微小上昇していた点を探す。
      // 複数見つかれば、それまでの連鎖が一番長いものを採用する
      // (より長く検証済みの伝播に乗せたほうが信頼できるため)。
      // ただし、候補の連鎖を遡った先に自分自身が含まれる場合は使わない
      // (A→B→A のような循環リンクができるのを未然に防ぐ。観測点が
      // 閾値付近で上下動を繰り返すと起こり得るため)。
      let bestPredecessor = null;
      for (const np of point.nearPoints) {
        const neighbor = points.get(np.id);
        if (!neighbor || neighbor.lastMicroRiseTick == null) continue;
        const tickDiff = tick - neighbor.lastMicroRiseTick;
        if (tickDiff <= 0) continue; // 同tick・未来は伝播元として扱わない
        const seconds = tickDiff * params.tickIntervalSeconds;
        const speedKmS = np.distanceKm / seconds;
        if (speedKmS < params.pWaveMinSpeedKmS || speedKmS > params.pWaveMaxSpeedKmS) continue;
        if (chainContainsId(neighbor, point.id, points, params.microChainMinLength + 5)) continue;
        if (!bestPredecessor || neighbor.microChainLength > bestPredecessor.microChainLength) {
          bestPredecessor = neighbor;
        }
      }

      point.lastMicroRiseTick = tick;
      if (bestPredecessor) {
        point.microChainFromId = bestPredecessor.id;
        point.microChainLength = bestPredecessor.microChainLength + 1;
      } else {
        point.microChainFromId = null;
        point.microChainLength = 1;
      }

      if (point.microChainLength < params.microChainMinLength) continue;

      // 連鎖が既定の長さに達した → 連鎖をたどってメンバー全員を集め、
      // イベントに割り当てる(相乗り中の既存イベントがあれば統合する)。
      // 訪問済みIDを記録し、万一データ不整合で循環が紛れ込んでいても
      // 無限ループにならないようにする(安全弁)。
      const chainMembers = [];
      const visitedIds = new Set();
      let cursor = point;
      while (cursor && !visitedIds.has(cursor.id)) {
        visitedIds.add(cursor.id);
        chainMembers.push(cursor);
        cursor = cursor.microChainFromId != null ? points.get(cursor.microChainFromId) : null;
      }

      const relatedEventIds = new Set();
      for (const m of chainMembers) if (m.eventId != null) relatedEventIds.add(m.eventId);
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

      for (const m of chainMembers) {
        const level = intensityToShakeLevel(m.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, m, level, now, params);
        m.pendingSince = null;
      }
      // 3点以上での速度一貫性という強い裏付けがあるため、待たずに確定扱いにする。
      targetEvent.confirmed = true;
    }

    // 4) イベント割当。震度0未満・かつ近傍がある点は、ステップ3の伝播速度
    //    連鎖で扱うためここでは対象外にする。孤立点(近傍なし)はそもそも
    //    近傍N点中K点方式が組めないため、従来どおりisolatedRiseThresholdで
    //    単独判定する。それ以外(震度0以上、または震度0未満でも孤立点)は、
    //    detectionRulesのアンサンブルで判定する(近傍の裏付けもルールに
    //    組み込まれているため、任意の1点との時間窓一致は見ない)。
    for (const point of points.values()) {
      const isolated = point.nearPoints.length === 0;

      if (isolated) {
        if (point.lastRiseTick !== tick) continue;

        if (point.eventId != null) {
          const event = this.events.get(point.eventId);
          if (event) {
            const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
            addPointToEvent(event, point, level, now, params);
          }
          point.pendingSince = null;
          continue;
        }

        const isolatedAvgOk = point.avgDiff == null || point.avgDiff >= params.isolatedAvgRiseThreshold;
        const triggered = point.intensityDiff >= params.isolatedRiseThreshold && isolatedAvgOk;
        if (!triggered) {
          if (point.pendingSince == null) point.pendingSince = tick;
          continue;
        }
        point.pendingSince = null;

        const targetEvent = createEvent(now);
        this.events.set(targetEvent.id, targetEvent);
        const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, point, level, now, params);
        // 孤立トリガー(近傍なしで単独発火)は、単独でも高いしきい値を越えて
        // いるため、待たずにそのまま確定扱いにする。
        targetEvent.confirmed = true;
        continue;
      }

      if (point.latestIntensity == null || point.latestIntensity < params.microChainIntensityCeiling) continue; // それ未満はステップ3で扱う

      if (point.eventId != null) {
        // 既にイベントに属している点は、ルールを満たしていればレベル・
        // 寿命を更新するだけ(裏付けとなった近傍も合流させる)。
        const result = evaluateDetectionRules(point, points, params.detectionRules);
        if (result.matched) {
          const event = this.events.get(point.eventId);
          if (event) {
            const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
            addPointToEvent(event, point, level, now, params);
            for (const nb of result.matchedNeighbors) {
              const nbLevel = intensityToShakeLevel(nb.latestIntensity, params.levelThresholds);
              addPointToEvent(event, nb, nbLevel, now, params);
            }
          }
        }
        continue;
      }

      const result = evaluateDetectionRules(point, points, params.detectionRules);
      if (!result.matched) continue; // ルールは近傍の裏付けを内包しているため、pendingは使わない

      // ルールを満たした近傍のうち、既にイベントに属している点があれば合流する。
      const relatedEventIds = new Set();
      for (const nb of result.matchedNeighbors) if (nb.eventId != null) relatedEventIds.add(nb.eventId);
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
      for (const nb of result.matchedNeighbors) {
        const nbLevel = intensityToShakeLevel(nb.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, nb, nbLevel, now, params);
      }
    }

    // 5) pendingのまま長く裏付けを得られない点は静かに諦める(誤報にしない。
    //    現在はisolated点のみがpendingSinceを使う)。
    for (const point of points.values()) {
      if (point.pendingSince != null && tick - point.pendingSince > params.pendingExpireTicks) {
        point.pendingSince = null;
      }
    }

    // 6) 確定した揺れの周辺への面的な拡張(BFS)。2点同時多発の裏付けが
    //    取れた点(イベントの核)を起点に、単独では検知の裏付けにならない
    //    程度の弱い上昇(propagationRiseThreshold)でも、既存イベントの
    //    近傍であればそのまま同じイベントに取り込んでいく。これにより、
    //    核から面として自然に広がり、検知エリアがまだらに欠けるのを防ぐ
    //    (eq_detection.jsのexpandDetectedAreaの考え方を移植)。
    //    ただし、イベントの発生起点(originLat/originLon)からの距離が
    //    propagationMaxRadiusKmを超える点へは拡張しない。上限が無いと、
    //    途中の弱いノイズを挟んで領域が際限なく広がり、地理的に離れた
    //    別々の地震のイベント同士が誤って統合されてしまうため。
    const propagationQueue = [];
    for (const point of points.values()) {
      if (point.eventId != null) propagationQueue.push(point.id);
    }
    let qi = 0;
    while (qi < propagationQueue.length) {
      const current = points.get(propagationQueue[qi++]);
      const event = this.events.get(current.eventId);
      if (!event) continue;
      for (const np of current.nearPoints) {
        const neighbor = points.get(np.id);
        if (!neighbor || neighbor.eventId != null) continue;
        if (neighbor.latestIntensity == null) continue;
        if (neighbor.intensityDiff < params.propagationRiseThreshold) continue;
        if (event.originLat != null) {
          const distFromOrigin = haversineKm(event.originLat, event.originLon, neighbor.lat, neighbor.lon);
          if (distFromOrigin > params.propagationMaxRadiusKm) continue;
        }
        const level = intensityToShakeLevel(neighbor.latestIntensity, params.levelThresholds);
        addPointToEvent(event, neighbor, level, now, params);
        neighbor.pendingSince = null;
        propagationQueue.push(neighbor.id);
      }
    }

    // 7) 領域が近い(または重なる)イベント同士の統合。1回のtickで広範囲に
    //    同時多発したイベント群が、小さなイベントのまま乱立しないよう、
    //    「これ以上統合できるペアが無くなるまで」繰り返す(連鎖的な統合)。
    let merged = true;
    while (merged) {
      merged = false;
      const eventList = [...this.events.values()];
      for (let i = 0; i < eventList.length; i++) {
        const a = eventList[i];
        if (!this.events.has(a.id) || a.centerLat == null) continue;
        for (let j = i + 1; j < eventList.length; j++) {
          const b = eventList[j];
          if (!this.events.has(b.id) || b.centerLat == null) continue;
          if (rectMinDistanceKm(a, b) <= params.mergeDistanceKm) {
            mergeEventInto(a, b);
            this.events.delete(b.id);
            merged = true;
          }
        }
      }
    }

    // 8) 期限切れイベントの削除
    for (const [id, event] of this.events) {
      if (event.expireAt < now) this.events.delete(id);
    }

    // detectionTimes(Map)は外部にそのまま渡さず、epicenterEstimation.tsが
    // 使いやすい配列形式(detections)に変換して返す。震源推定を使わない
    // 既存の呼び出し側(App.jsx等)には影響しない追加フィールドなので、
    // 他のフィールド(level/pointCount/centerLat/centerLon/confirmed等)の
    // 扱いはこれまでと変わらない。
    return [...this.events.values()]
      .filter(e => e.centerLat != null)
      .map(e => {
        const { detectionTimes, ...rest } = e;
        return {
          ...rest,
          pointIds: [...e.pointIds],
          detections: [...detectionTimes].map(([id, d]) => ({ id, lat: d.lat, lon: d.lon, detectedAt: d.detectedAt, level: d.level })),
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
