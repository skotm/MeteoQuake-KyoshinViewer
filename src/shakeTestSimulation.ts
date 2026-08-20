/**
 * shakeTestSimulation.ts
 * ------------------------------------------------------------
 * 「地震検知テスト」(実験的機能)用の、簡易的な地震動シミュレーター。
 * ユーザー提供の地震シミュレーターアプリ(index.html)のPGV距離減衰式・
 * P波/S波到達時刻モデルを参考にした簡略版。
 *
 * 要件により、AVS30地盤増幅・断層破壊伝播・指向性は含めない(全国一律の
 * 地盤・点震源として扱う、シンプル版)。
 *
 * 実際のリアルタイム観測点データ(realtimeValues)と全く同じ形
 * (Map<観測点id, 震度相当値>)で値を生成することで、揺れ検知エンジン
 * (shakeDetection.ts)や地図描画から見て、本物のデータと区別なく扱える
 * ようにしている。
 */

// 参考アプリのV_MODEL(浅い深さでの代表速度)に相当する、簡易版の固定P波/S波速度(km/s)。
const P_WAVE_SPEED_KM_S = 6.8;
const S_WAVE_SPEED_KM_S = 3.9;

// 揺れが到達する前の平常時の値(shindoColorScale.tsの配色スケール下限に合わせる)
const BASELINE_INTENSITY = -3.0;
// P波到達時点で立ち上がる、最終震度(ピーク値)に対する割合(初期微動用)
const P_WAVE_RATIO = 0.25;
// S波到達後、ピークまで立ち上がる時間(ms)
const RISE_DURATION_MS = 1500;
// ピーク後、平常値まで指数的に減衰していく時間の目安(ms)
const DECAY_DURATION_MS = 18000;

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 震源からの震源距離・M・深さから、その観測点の最終的な震度相当値(ピーク値)を
// 求める。参考アプリのcalculateIntensityから、AVS30地盤増幅・断層破壊伝播・
// 指向性を除いたシンプル版(地盤は全国平均相当で一律とみなす)。
function calcPeakIntensity(magnitude, depthKm, distHypoKm) {
  const mw = magnitude > 7.5 ? magnitude - 0.2 : magnitude;
  const c = 0.0025 * Math.pow(10, 0.50 * mw);
  const x = distHypoKm + c;
  const logPgv = 0.58 * mw + 0.0038 * depthKm - 1.29 - Math.log10(x) - 0.0024 * x;
  const pgv = Math.pow(10, logPgv);
  let intensity = 2.68 + 1.72 * Math.log10(pgv);
  if (intensity > 7.5) intensity = 7.5 + (intensity - 7.5) * 0.1;
  return intensity;
}

function travelTimeMs(distKm, depthKm, speedKmS) {
  const distHypo = Math.sqrt(distKm * distKm + depthKm * depthKm);
  return (distHypo / speedKmS) * 1000;
}

/**
 * テスト用の震源情報(lat, lon, magnitude, depthKm)と観測点一覧から、
 * 各観測点の到達時刻・ピーク震度を事前計算する。シミュレーション開始時に
 * 1回だけ呼べばよい(重い処理ではないが、毎tick呼ぶ必要はない)。
 */
export function prepareShakeTest(quake, stations) {
  const { lat, lon, magnitude, depth } = quake;
  const perStation = new Map();
  for (const s of stations) {
    const distKm = haversineKm(lat, lon, s.lat, s.lon);
    const distHypoKm = Math.sqrt(distKm * distKm + depth * depth);
    const peak = calcPeakIntensity(magnitude, depth, distHypoKm);
    const pArrivalMs = travelTimeMs(distKm, depth, P_WAVE_SPEED_KM_S);
    const sArrivalMs = travelTimeMs(distKm, depth, S_WAVE_SPEED_KM_S);
    perStation.set(s.id, { peak, pArrivalMs, sArrivalMs });
  }
  return perStation;
}

/**
 * 経過時間(ms)から、その時点での観測点ごとの震度相当値を計算する。
 * 戻り値はrealtimeValuesと同じ形のMap(P波がまだ届いていない観測点は
 * キー自体を含めない = 「データなし」として扱われる)。
 */
export function computeShakeTestValues(perStation, elapsedMs) {
  const values = new Map();
  for (const [id, st] of perStation) {
    if (elapsedMs < st.pArrivalMs) continue;
    let value;
    if (elapsedMs < st.sArrivalMs) {
      // P波到達後・S波到達前 — 弱い初期微動
      const t = (elapsedMs - st.pArrivalMs) / Math.max(1, st.sArrivalMs - st.pArrivalMs);
      value = BASELINE_INTENSITY + (st.peak * P_WAVE_RATIO - BASELINE_INTENSITY) * t;
    } else {
      const sinceS = elapsedMs - st.sArrivalMs;
      if (sinceS < RISE_DURATION_MS) {
        // S波到達後、ピークまで立ち上がる
        const t = sinceS / RISE_DURATION_MS;
        value = st.peak * P_WAVE_RATIO + (st.peak - st.peak * P_WAVE_RATIO) * t;
      } else {
        // ピーク後、平常値まで指数的に減衰
        const t = (sinceS - RISE_DURATION_MS) / DECAY_DURATION_MS;
        const decay = Math.exp(-3 * Math.min(1, t));
        value = BASELINE_INTENSITY + (st.peak - BASELINE_INTENSITY) * decay;
      }
    }
    values.set(id, value);
  }
  return values;
}

// このテストが「終わった」とみなせるか(全観測点が平常値近くまで減衰し終えたか)の目安。
// 経過時間がこれを超えたら、呼び出し側で自動的にテストを終了してよい。
export function isShakeTestFinished(perStation, elapsedMs) {
  let maxSArrivalMs = 0;
  for (const st of perStation.values()) maxSArrivalMs = Math.max(maxSArrivalMs, st.sArrivalMs);
  return elapsedMs > maxSArrivalMs + RISE_DURATION_MS + DECAY_DURATION_MS + 3000;
}
