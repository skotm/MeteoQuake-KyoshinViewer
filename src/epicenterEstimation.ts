/**
 * epicenterEstimation.ts
 * ------------------------------------------------------------
 * 揺れ検知イベント(shakeDetection.tsのShakeDetectionEngineが生成するイベント)
 * から、検知時刻に加えて「揺れの広がり方(震度の減衰パターン)」「その方向」も
 * 手がかりにして震源(緯度・経度・深さ・発生時刻)を推定する。
 *
 * 参考: 「揺れ検知から震央を検出してみる」
 * (https://note.com/kotoho7/n/n59e423877b1b) のGeiger法ベースの自己流
 * アルゴリズムを踏襲した簡易版。検知時刻ベースの走時解析(本編)に加えて、
 * 記事の「おまけ」(振幅・B-Δ法・主成分分析による方位)の考え方も簡易的に
 * 取り込んでいる:
 *   - 初期仮震源: 最初に検知した1点だけでなく、検知済み観測点の震度で
 *     重み付けした重心(震度が高い観測点ほど震源に近いはず、という直感)を使う。
 *   - 誤差レベル: 到達時刻の分散(本編)に加えて、shakeTestSimulation.tsの
 *     震度減衰式(calcPeakIntensity)を使い、候補震源の位置・深さで観測された
 *     震度パターンを最もよく説明できるマグニチュードを探索し、そのときの
 *     残差をペナルティとして加算する(computeAmplitudeCalibrationPenalty)。
 *
 * 【なぜ単純な相関ではなく震度減衰式を使うか】
 * 当初は「震央距離の対数」と「震度」の相関係数(遠いほど震度が低いはず)だけを
 * 見ていたが、これは観測点同士の相対的な順序しか見ておらず、観測点が海側に
 * 観測点を持たない(=陸地に偏って検知している)沖合の地震では、候補を
 * 陸地からどれだけ沖へ動かしても観測点間の相対的な震度の順序はほぼ変わらない
 * ため、実際よりはるかに沖合まで誤って推定してしまう不具合があった
 * (検証で確認済み)。calcPeakIntensityの非弾性減衰項(-0.003*距離)は
 * 単純な比例関係ではなく、距離が伸びるほど減衰が加速する非線形カーブなので、
 * 「観測された震度パターンにもっとも合うマグニチュード」を仮定して初めて、
 * 候補までの絶対距離(震源が陸地寄りか沖合遠くか)にも制約がかかる。
 * 気象庁の改良IPF法のような正式な校正済みモデルではなく、あくまで
 * shakeTestSimulation.tsの簡易減衰式を流用した近似であることに注意。
 *
 * 走時計算はJMA2001走時表を使わず、shakeTestSimulation.tsと同じ固定P波
 * 速度モデル(震源距離÷速度)を流用している。テスト用シミュレーターと
 * 震源推定ロジックの物理モデルを一致させることで、地震検知テスト機能
 * (実験的機能)でこのモジュールの動作確認がしやすいようにするため。
 *
 * 【重い処理にならないための設計】
 * - ここの関数はshakeDetection.tsのprocessTick()内からは呼ばない
 *   (検知エンジン自体の毎tickコストを増やさないため、呼び出しは
 *   App.jsx側の責務にする)。
 * - estimateEpicenter()は状態を持たない純粋関数。EpicenterEstimatorは
 *   イベントごとに「最後に推定した時の検知点数(pointCount)」を覚えておき、
 *   点数が変化していなければ前回の結果をそのまま返す(=無駄な再計算をしない)。
 *   揺れ検知イベントは同じtickで何度もpointCountが変わるものではないため、
 *   これだけでほとんどのtickの計算をスキップできる。
 * - 反復移動(Geiger法簡略版)は4ステップ固定・各ステップ4〜6候補で、
 *   さらに1ステップ内の改善ループにも上限(MAX_STEP_ITERATIONS)を設けて
 *   あり、パラメータ次第で振動して終わらなくなることがないようにしている。
 * - 着未着法(未検知観測点のチェック)は、全観測点ではなく「検知済み観測点の
 *   最大震央距離+30km」の範囲内だけを対象にし、かつ検知初期(3秒以内 or
 *   30点未満)のみ有効にすることで、観測点が多い場合のコストを抑えている。
 * - 震度の減衰パターンによるペナルティ(computeAmplitudeCalibrationPenalty)は、
 *   マグニチュード候補(CALIBRATION_MAGNITUDE_CANDIDATES、十数通り)×検知済み
 *   観測点数のオーダーで、候補震源1つあたりO(定数×n)。候補評価全体の回数
 *   (反復移動のステップ数×イテレーション上限×候補数)は変わらないため、
 *   全体としても線形の増加に収まる。
 */

import { P_WAVE_SPEED_KM_S, calcPeakIntensity } from "./shakeTestSimulation";

// 仮震源の初期値
const INITIAL_DEPTH_KM = 10;
const ORIGIN_TIME_FALLBACK_OFFSET_MS = 2000; // 重み計算が成立しない場合のフォールバックにのみ使用

// 誤差レベル計算時の重み: この震央距離(km)以内は重み1に固定する
const NEAR_STATION_FIXED_WEIGHT_RADIUS_KM = 50;

// 着未着法を有効にする条件
const UNDETECTED_CHECK_MAX_ELAPSED_MS = 3000;
const UNDETECTED_CHECK_MAX_POINTS = 30;
const UNDETECTED_CHECK_MARGIN_KM = 30;

// 揺れの広がり方(震度の減衰パターン)による誤差レベルへのペナルティの重み。
// 到達時刻の分散(ms^2オーダー、状況により数百〜数十万)と足し合わせて使うため、
// 極端に小さいと影響力が無く、極端に大きいと震度データのノイズに引っ張られ
// 過ぎてしまう。着未着法のペナルティ(整数の加算、多くても数百)と同程度〜
// やや強めのオーダーを目安に、暫定的にこの値にしている(要調整)。
const AMPLITUDE_PENALTY_WEIGHT = 4000;
// マグニチュード探索の最低点数(点数が少なすぎると最良マグニチュードの
// フィットが不安定になるため)。
const MIN_POINTS_FOR_AMPLITUDE_CHECK = 3;
// 「観測された震度パターンに最も合うマグニチュード」を粗く探索するための
// 候補値。0.5刻みなので精度は粗いが、あくまで震源までの絶対距離に制約を
// 掛けるためのものであり、マグニチュードそのものの推定精度は目的にしていない。
const CALIBRATION_MAGNITUDE_CANDIDATES = [3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5, 8.0];

// 反復移動: 1ステップ内で「候補に移動」を繰り返す回数の上限(暴走防止)
const MAX_STEP_ITERATIONS = 12;

// 反復移動の安全弁: 初期仮震源(最初に検知した観測点)からこれ以上離れた候補は
// 採用しない。
//
// 【なぜ必要か】重み(weightForDistance)は遠い観測点ほど誤差レベルへの寄与を
// 小さくする設計だが、検知済み観測点が互いに近接している(＝震央距離の
// バリエーションが乏しい)状況で深さの初期値がずれていると、候補を無限に
// 遠ざけるほど観測点間の到達時刻差が(候補から見て)ほぼ同じ角度に潰れて
// 分散が縮み、誤差レベルが際限なく下がってしまう退化解が発生しうる
// (実データでの検証中に確認済み)。日本近海の地震という前提で、初期仮震源
// から現実的にあり得ない距離まで暴走するのを防ぐための上限。
const MAX_DISTANCE_FROM_INITIAL_KM = 600;

// 反復移動の4ステップ(緯度経度の変化量→変化量→深さも含める→深さを細かく)。
//
// 参考記事の元の手順は最初の2ステップで深さを固定するが、それをそのまま
// 実装すると「初期深さ(10km)が実際の深さから大きく外れている」場合に、
// 緯度経度だけの移動では埋め合わせようがない大きな時刻残差を抱えたまま
// ステップ1・2が探索することになり、遠方の候補ほど観測点間の到達時刻差が
// 見かけ上小さくなる(観測点同士が近接している場合に起きる)性質に引っ張られて
// 誤った方向へ暴走することを検証で確認した。そのため、ステップ1・2にも
// 大まかな深さ調整(coarseDeltaDepthKm)を追加し、深さの大外れを早い段階で
// ある程度補正できるようにしている(ステップ3・4は元の手順どおり、緯度経度と
// 深さを本格的に追い込む)。
const REFINEMENT_STEPS = [
  { deltaDegList: [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]], deltaDepthKm: null, coarseDeltaDepthKm: 100 },
  { deltaDegList: [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]], deltaDepthKm: null, coarseDeltaDepthKm: 30 },
  { deltaDegList: [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]], deltaDepthKm: 50, coarseDeltaDepthKm: null },
  { deltaDegList: [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]], deltaDepthKm: 10, coarseDeltaDepthKm: null },
];

// 震源推定として意味のある最低検知点数(これ未満はnullを返す)
const MIN_DETECTION_POINTS = 2;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// shakeTestSimulation.tsのtravelTimeMsと同じ考え方(震源距離÷速度)。
// P波/S波の判別はせず、常にP波速度モデルを使う(記事同様の簡略化)。
function travelTimeMs(distKm, depthKm) {
  const distHypo = Math.sqrt(distKm * distKm + depthKm * depthKm);
  return (distHypo / P_WAVE_SPEED_KM_S) * 1000;
}

function weightForDistance(distKm, firstDistKm) {
  if (distKm <= NEAR_STATION_FIXED_WEIGHT_RADIUS_KM) return 1;
  return firstDistKm / Math.max(distKm, 0.001);
}

// 震度(level)を、相対的な重み付けに使えるPGV相当値に変換する。
// shakeTestSimulation.tsのcalcPeakIntensity(intensity = 2.68 + 1.72*log10(pgv))
// の逆関数で、絶対値としての精度は求めていない(観測点間の相対比較にのみ使う)。
// 震度が高い観測点ほど指数的に大きな重みになる。
function pgvWeightForLevel(level) {
  return Math.pow(10, (level - 2.68) / 1.72);
}

// 検知済み観測点を震度(level)で重み付けした重心を求める。震度が高い(揺れが
// 強い)観測点ほど震源に近いはず、という直感を仮震源の初期位置に反映させる
// ためのもの。levelを持たない観測点しかない場合はnullを返す(呼び出し側で
// 最初に検知した観測点にフォールバックする)。
function computeAmplitudeWeightedCentroid(detections) {
  let sumLat = 0, sumLon = 0, sumWeight = 0;
  for (const d of detections) {
    if (d.level == null) continue;
    const w = pgvWeightForLevel(d.level);
    sumLat += d.lat * w;
    sumLon += d.lon * w;
    sumWeight += w;
  }
  if (sumWeight <= 0) return null;
  return { lat: sumLat / sumWeight, lon: sumLon / sumWeight };
}

// 揺れの広がり方(震度の減衰パターン)が、候補震源(位置・深さ)から見て
// 物理的にもっともらしいかを評価する。shakeTestSimulation.tsの震度減衰式
// (calcPeakIntensity)を使い、観測された震度パターンに最もよく合う
// マグニチュードを粗く探索した上で、その残差(二乗誤差の合計)をペナルティに
// する。単純な「震度と距離の順序が合っているか」の相関ではなく、実際の
// 減衰カーブ(非弾性減衰項を含む、距離が伸びるほど加速する非線形カーブ)を
// 使うことで、観測点が一方向(陸側)に偏っている沖合の地震でも、候補を
// 沖へ動かしすぎると(実際の震度パターンに対して)説明が悪くなるようにし、
// 震源までの絶対距離にも制約がかかるようにしている(詳細はファイル冒頭の
// コメント参照)。
// 観測点数が少ない場合はフィットが不安定なため計算をスキップする(0を返す)。
function computeAmplitudeCalibrationPenalty(candidate, detections) {
  if (detections.length < MIN_POINTS_FOR_AMPLITUDE_CHECK) return 0;

  const withLevel = detections.filter(d => d.level != null);
  if (withLevel.length < MIN_POINTS_FOR_AMPLITUDE_CHECK) return 0;

  const distHypoByStation = withLevel.map(d => {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    return Math.sqrt(distKm * distKm + candidate.depthKm * candidate.depthKm);
  });

  let best = Infinity;
  for (const m of CALIBRATION_MAGNITUDE_CANDIDATES) {
    let sumSq = 0;
    for (let i = 0; i < withLevel.length; i++) {
      const predicted = calcPeakIntensity(m, candidate.depthKm, distHypoByStation[i]);
      const diff = predicted - withLevel[i].level;
      sumSq += diff * diff;
    }
    if (sumSq < best) best = sumSq;
  }

  return AMPLITUDE_PENALTY_WEIGHT * best;
}

// 検知済み観測点群から、重み付き平均発生時刻を計算する。
function computeWeightedOriginTime(candidate, detections, firstDistKm) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const d of detections) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    const tt = travelTimeMs(distKm, candidate.depthKm);
    const originTime = d.detectedAt - tt;
    const weight = weightForDistance(distKm, firstDistKm);
    weightedSum += originTime * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

/**
 * 候補震源の誤差レベルを計算する(小さいほど実際の震源に近い)。
 * detections: [{id, lat, lon, detectedAt}] (最初に検知した観測点を含む)
 * allStations: 着未着法用の全観測点マスタ([{id,lat,lon}, ...])。nullなら着未着法をスキップ。
 */
function computeErrorLevel(candidate, detections, firstDistKm, allStations, now) {
  const meanOriginTime = computeWeightedOriginTime(candidate, detections, firstDistKm);
  if (meanOriginTime == null) return Infinity;

  let errorLevel = 0;
  let maxDetDistKm = 0;
  for (const d of detections) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    if (distKm > maxDetDistKm) maxDetDistKm = distKm;
    const tt = travelTimeMs(distKm, candidate.depthKm);
    const originTime = d.detectedAt - tt;
    const weight = weightForDistance(distKm, firstDistKm);
    const diff = originTime - meanOriginTime;
    errorLevel += weight * diff * diff;
  }

  // 揺れの広がり方(震度の減衰パターン)による整合性ペナルティ。到達時刻の
  // 分散だけでは区別しにくい候補同士(特に、観測点が一方向に偏っていて
  // 絶対距離が決まりにくい沖合の地震)を、震度パターンの物理的な説明の
  // 良さで追加的に絞り込む(詳細はcomputeAmplitudeCalibrationPenalty参照)。
  errorLevel += computeAmplitudeCalibrationPenalty(candidate, detections);

  // 着未着法: 検知初期(3秒以内、または検知点数が30点未満)のみ、未検知観測点への
  // ペナルティを加える。対象は「検知済み観測点の最大震央距離+30km」以内に限定し、
  // 観測点数が多い場合でもコストが膨らまないようにする。
  if (allStations) {
    const firstDetectedAt = Math.min(...detections.map(d => d.detectedAt));
    const elapsedSinceFirst = now - firstDetectedAt;
    if (elapsedSinceFirst <= UNDETECTED_CHECK_MAX_ELAPSED_MS || detections.length < UNDETECTED_CHECK_MAX_POINTS) {
      const detectedIds = new Set(detections.map(d => d.id));
      const searchRadius = maxDetDistKm + UNDETECTED_CHECK_MARGIN_KM;
      for (const s of allStations) {
        if (detectedIds.has(s.id)) continue;
        const distKm = haversineKm(candidate.lat, candidate.lon, s.lat, s.lon);
        if (distKm > searchRadius) continue;
        const tt = travelTimeMs(distKm, candidate.depthKm);
        const arrivalTime = meanOriginTime + tt;
        if (now > arrivalTime) errorLevel += 1;
      }
    }
  }

  return errorLevel;
}

// 仮震源の周りに候補を作り、誤差レベルが最も低い候補があればそこへ移動する、を
// 改善が無くなるまで繰り返す(MAX_STEP_ITERATIONSで打ち切り、無限ループを防ぐ)。
// initialLat/initialLon: 反復開始時の位置(最初に検知した観測点)。
// MAX_DISTANCE_FROM_INITIAL_KMを超える候補は、誤差レベルの値に関わらず採用しない
// (退化解への暴走を防ぐ安全弁。詳細は定数側のコメント参照)。
function refineStep(current, currentError, step, detections, firstDistKm, allStations, now, initialLat, initialLon) {
  let candidate = current;
  let candidateError = currentError;

  for (let iter = 0; iter < MAX_STEP_ITERATIONS; iter++) {
    const trials = step.deltaDegList.map(([dLat, dLon]) => ({
      lat: candidate.lat + dLat,
      lon: candidate.lon + dLon,
      depthKm: candidate.depthKm,
    }));
    if (step.deltaDepthKm) {
      trials.push({ lat: candidate.lat, lon: candidate.lon, depthKm: Math.max(0, candidate.depthKm + step.deltaDepthKm) });
      trials.push({ lat: candidate.lat, lon: candidate.lon, depthKm: Math.max(0, candidate.depthKm - step.deltaDepthKm) });
    }
    if (step.coarseDeltaDepthKm) {
      trials.push({ lat: candidate.lat, lon: candidate.lon, depthKm: Math.max(0, candidate.depthKm + step.coarseDeltaDepthKm) });
      trials.push({ lat: candidate.lat, lon: candidate.lon, depthKm: Math.max(0, candidate.depthKm - step.coarseDeltaDepthKm) });
    }

    let best = null;
    let bestError = candidateError;
    for (const t of trials) {
      if (haversineKm(initialLat, initialLon, t.lat, t.lon) > MAX_DISTANCE_FROM_INITIAL_KM) continue;
      const err = computeErrorLevel(t, detections, firstDistKm, allStations, now);
      if (err < bestError) {
        bestError = err;
        best = t;
      }
    }
    if (!best) break; // これ以上改善する候補が無ければこのステップは終了
    candidate = best;
    candidateError = bestError;
  }

  return { candidate, error: candidateError };
}

/**
 * イベントから震源を推定する(1回分の計算を行う純粋関数)。
 *
 * event: shakeDetection.tsのprocessTick()が返すイベント(detectionsフィールドを持つもの)。
 * allStations: 着未着法用の全観測点マスタ([{id,lat,lon}, ...])。省略時は着未着法をスキップする。
 * now: 現在時刻(ms)。省略時はDate.now()。
 *
 * 戻り値: { lat, lon, depthKm, originTime, errorLevel, pointCount } | null
 * (検知点数がMIN_DETECTION_POINTS未満の場合はnull=推定不能)
 */
export function estimateEpicenter(event, allStations = null, now = Date.now()) {
  const detections = event?.detections;
  if (!detections || detections.length < MIN_DETECTION_POINTS) return null;

  // 最初に検知した観測点(発生時刻の基準・重み計算の基準距離に使う)。
  let first = detections[0];
  for (const d of detections) {
    if (d.detectedAt < first.detectedAt) first = d;
  }

  // 仮震源の初期位置は、検知時刻だけでなく「揺れの広がり方」も最初から
  // 反映させるため、震度で重み付けした重心(computeAmplitudeWeightedCentroid)
  // を使う。震度データが無い等で重心が求まらない場合は、従来どおり最初に
  // 検知した観測点の位置にフォールバックする。
  const centroid = computeAmplitudeWeightedCentroid(detections);
  const initialPos = centroid ?? { lat: first.lat, lon: first.lon };

  let candidate = {
    lat: Math.round(initialPos.lat * 100) / 100,
    lon: Math.round(initialPos.lon * 100) / 100,
    depthKm: INITIAL_DEPTH_KM,
  };
  const firstDistKm = haversineKm(candidate.lat, candidate.lon, first.lat, first.lon) || 0.001;
  let error = computeErrorLevel(candidate, detections, firstDistKm, allStations, now);

  const initialLat = candidate.lat;
  const initialLon = candidate.lon;
  for (const step of REFINEMENT_STEPS) {
    const result = refineStep(candidate, error, step, detections, firstDistKm, allStations, now, initialLat, initialLon);
    candidate = result.candidate;
    error = result.error;
  }

  const originTime = computeWeightedOriginTime(candidate, detections, firstDistKm)
    ?? (first.detectedAt - ORIGIN_TIME_FALLBACK_OFFSET_MS);

  return {
    lat: candidate.lat,
    lon: candidate.lon,
    depthKm: candidate.depthKm,
    originTime,
    errorLevel: error,
    pointCount: detections.length,
  };
}

/**
 * イベントごとに最後に推定した検知点数(pointCount)を覚えておき、点数が
 * 変化していなければ再計算せず前回の結果を使い回すキャッシュラッパー。
 * App.jsx側はshakeDetection.tsのprocessTick()の戻り値をそのままupdateAll()に
 * 渡すだけでよい(震央検出のON/OFFや再計算タイミングを個別に管理する必要はない)。
 */
export class EpicenterEstimator {
  constructor() {
    this.cache = new Map(); // eventId -> { pointCount, result }
  }

  /**
   * events: shakeDetection.tsのprocessTick()の戻り値。
   * allStations: 着未着法用の全観測点マスタ。
   * 戻り値: Map<eventId, estimateEpicenter()の戻り値>
   */
  updateAll(events, allStations = null, now = Date.now()) {
    const activeIds = new Set();
    const results = new Map();

    for (const event of events) {
      activeIds.add(event.id);
      const cached = this.cache.get(event.id);
      if (cached && cached.pointCount === event.pointCount) {
        results.set(event.id, cached.result);
        continue;
      }
      const result = estimateEpicenter(event, allStations, now);
      this.cache.set(event.id, { pointCount: event.pointCount, result });
      results.set(event.id, result);
    }

    // 期限切れ・統合等で消えたイベントのキャッシュは掃除する(メモリリーク防止)。
    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }

    return results;
  }
}
