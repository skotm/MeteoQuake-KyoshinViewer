// 緊急地震速報(EEW)の第一報・揺れ検知の初検出時に、地図の視点を震源/検知位置へ移動する
// 共通処理。ズームは現在の倍率を FOCUS_MIN_ZOOM〜FOCUS_MAX_ZOOM に収める
// (ズーム6.5で画面幅およそ270km=震源の周辺数県が見える広さ)。
// 倍率を変えたい時はこの2つだけを変えればよい。
export const FOCUS_MIN_ZOOM = 6.0;
export const FOCUS_MAX_ZOOM = 7.0;

// points: { lat, lon }[]。1点ならその点へ移動(ズームは現在値を上の範囲に収める)、
// 複数点なら全てが収まるように移動する(最大ズームはFOCUS_MAX_ZOOM)。
export function focusMapOnPoints(map, points, isWide) {
  if (!map || !points || points.length === 0) return;
  const reducedMotion = typeof window !== "undefined"
    && window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = reducedMotion ? 0 : 1000;
  if (points.length === 1) {
    const zoom = Math.min(FOCUS_MAX_ZOOM, Math.max(FOCUS_MIN_ZOOM, map.getZoom()));
    map.easeTo({
      center: [points[0].lon, points[0].lat],
      zoom,
      duration,
      // 横画面ではフローティングパネルが画面左側(約360px)を覆っているので、
      // 見た目の中心が隠れない範囲の中央に来るようずらす(震源選択時と同じ)。
      offset: isWide ? [230, 0] : [0, 0],
    });
    return;
  }
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const p of points) {
    minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  }
  map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding: isWide
      ? { top: 40, bottom: 40, left: 460, right: 40 }
      : { top: 80, bottom: 220, left: 40, right: 40 },
    maxZoom: FOCUS_MAX_ZOOM,
    duration,
  });
}
