


// 揺れ検知イベント(shakeEvents)に含まれる、個々の「検知済み観測点」
// (event.detections、ShakeDetectionEngineが揺れ有りと判定した観測点の
// 一覧)のidをまとめたSetを作る。realtime-points-layerの各featureに
// isDetectedフラグを立てるために使う(検知済みの観測点だけ縁取りを太い
// 黒にする。別レイヤーで円を重ねる方式は、観測点が密集する場面で円同士が
// 重なり合って黒く塗りつぶれたように見えてしまう問題があったため、この
// 点自体の縁取りを変える方式に変更した)。
export function buildDetectedStationIdSet(shakeEvents) {
  const ids = new Set();
  for (const e of shakeEvents) {
    if (!e.detections) continue;
    for (const d of e.detections) ids.add(d.id);
  }
  return ids;
}

/* ─────────────────────────────────────────────────────
   震源推定(epicenterEstimation.ts / EpicenterEstimator)のマーカー用ヘルパー。
   揺れ検知イベントごとの推定結果(estimateEpicenter()の戻り値)を、
   地図上に置くPoint Featureに変換する。実際の震源とは限らない(あくまで
   検知時刻からの推定値)という性質上、断定的な×印ではなく、白丸+黒縁の
   controlしやすいシンプルな印にしている(circleレイヤーで描画)。
   ───────────────────────────────────────────────────── */

// estimates: Map<eventId, estimateEpicenter()の戻り値 | null>
// 検知点数が少なすぎて推定不能(null)のイベントは表示しない。
export function buildEpicenterEstimateFeatures(estimates) {
  const features = [];
  for (const [eventId, est] of estimates) {
    if (!est) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [est.lon, est.lat] },
      properties: {
        eventId,
        depthKm: Math.round(est.depthKm),
        // 推定マグニチュード(estimateEpicenter側でfitMagnitudeにより算出)。
        // 検知点数が少ない・levelしか無い等で算出できなかった場合はnull。
        magnitude: est.magnitude,
        pointCount: est.pointCount,
        errorLevel: est.errorLevel,
        // 収束判定(EpicenterEstimator側で付与)。「検知点数が十分」かつ
        // 「推定位置がしばらく動いていない」の両方を満たすまでfalseになる。
        // 早い段階の大きくぶれた推定を、確定した推定と見分けられるようにする。
        confirmed: !!est.confirmed,
        // 隣に表示する「推定深さ・推定M」ラベル用のアイコンid。実体は
        // updateEpicenterEstimateLabels側でeventIdごとに1枚だけ登録・
        // 更新するbitmap(registerOrUpdateEpicenterLabelIcon参照)。
        labelIconId: `epicenter-label-${eventId}`,
      },
    });
  }
  return features;
}

/* ─────────────────────────────────────────────────────
   震源推定マーカーの隣に表示する「推定深さ・推定M」ラベル。
   text-fieldはスタイルにglyphs(フォント配信)が無いと使えない
   (STATION_ICON_KEYSの説明コメント参照)ため、他のラベル同様、
   canvasに焼いたbitmapをicon-imageとして使う。ただし震度キーのような
   固定少数の組み合わせとは違い、深さ・マグニチュードは推定のたびに
   細かく変わる連続値のため、値ごとに新しい画像をaddImageし続けると
   際限なく増えてしまう。そのため「eventIdごとに固定の画像id・固定
   サイズのcanvasを1枚だけ持ち、内容が変わったらupdateImageで差し替える」
   方式にして、登録数をイベント数(通常は数件)の範囲に収める。
   ───────────────────────────────────────────────────── */
const EPICENTER_LABEL_CANVAS_WIDTH = 240;
const EPICENTER_LABEL_CANVAS_HEIGHT = 76;
// icon-imageは1つのbitmap内での座標(ピクセル)基準で解像度非依存に描画
// したいため、実際の表示解像度より高い倍率で焼いておく(文字がぼやけない
// ように)。station iconのSTATION_ICON_BASE_RADIUS同様の考え方。
export const EPICENTER_LABEL_CANVAS_SCALE = 2;

// depthKm・magnitudeから表示テキスト(2行)を組み立てる。呼び出し側の
// drawEpicenterLabelCanvas・updateEpicenterEstimateLabelsの両方から、
// 同じ内容かどうかの比較にも使う。
function buildEpicenterLabelText(depthKm, magnitude) {
  const line1 = `推定深さ: ${depthKm}km`;
  const line2 = magnitude != null ? `M: ${magnitude.toFixed(1)}` : "M: --";
  return `${line1}\n${line2}`;
}

export function drawEpicenterLabelCanvas(depthKm, magnitude) {
  const w = EPICENTER_LABEL_CANVAS_WIDTH * EPICENTER_LABEL_CANVAS_SCALE;
  const h = EPICENTER_LABEL_CANVAS_HEIGHT * EPICENTER_LABEL_CANVAS_SCALE;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);

  const FONT_STACK = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", "Noto Sans JP", sans-serif';
  const fontSize = 20 * EPICENTER_LABEL_CANVAS_SCALE;
  const lineHeight = fontSize * 1.35;
  const paddingX = 12 * EPICENTER_LABEL_CANVAS_SCALE;
  const paddingY = 8 * EPICENTER_LABEL_CANVAS_SCALE;

  const [line1, line2] = buildEpicenterLabelText(depthKm, magnitude).split("\n");

  ctx.font = `700 ${fontSize}px ${FONT_STACK}`;
  const textWidth = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width);
  const boxWidth = Math.min(w, textWidth + paddingX * 2);
  const boxHeight = lineHeight * 2 + paddingY * 2;

  // 半透明の角丸背景(地図上の他の情報と重なっても文字が読めるように)。
  const radius = 8 * EPICENTER_LABEL_CANVAS_SCALE;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(boxWidth, 0, boxWidth, boxHeight, radius);
  ctx.arcTo(boxWidth, boxHeight, 0, boxHeight, radius);
  ctx.arcTo(0, boxHeight, 0, 0, radius);
  ctx.arcTo(0, 0, boxWidth, 0, radius);
  ctx.closePath();
  ctx.fillStyle = "rgba(17,17,17,0.62)";
  ctx.fill();

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#FFFFFF";
  ctx.fillText(line1, paddingX, paddingY + lineHeight / 2);
  ctx.fillText(line2, paddingX, paddingY + lineHeight * 1.5);

  return ctx.getImageData(0, 0, w, h);
}

// map: MapLibreのMapインスタンス。cacheRef: { current: Map<eventId, text> }
// (前回登録した内容を覚えておき、変化していなければupdateImageを呼ばずに
// スキップするための単純なキャッシュ)。
export function updateEpicenterEstimateLabels(map, estimates, cacheRef) {
  if (!cacheRef.current) cacheRef.current = new Map();
  const cache = cacheRef.current;
  const activeIds = new Set();

  for (const [eventId, est] of estimates) {
    if (!est) continue;
    activeIds.add(eventId);
    const imageId = `epicenter-label-${eventId}`;
    const text = buildEpicenterLabelText(Math.round(est.depthKm), est.magnitude);
    if (cache.get(eventId) === text) continue; // 内容が変わっていなければ何もしない

    const imageData = drawEpicenterLabelCanvas(Math.round(est.depthKm), est.magnitude);
    if (map.hasImage(imageId)) {
      map.updateImage(imageId, imageData);
    } else {
      map.addImage(imageId, imageData, { pixelRatio: EPICENTER_LABEL_CANVAS_SCALE });
    }
    cache.set(eventId, text);
  }

  // もう存在しないイベントの画像を掃除する(放置すると際限なく増えるため)。
  for (const eventId of [...cache.keys()]) {
    if (activeIds.has(eventId)) continue;
    const imageId = `epicenter-label-${eventId}`;
    if (map.hasImage(imageId)) map.removeImage(imageId);
    cache.delete(eventId);
  }
}

/* ─────────────────────────────────────────────────────
   地震検知テスト(shakeTestSimulation.ts)用: テストで「実際に」設定した
   震源(=正解の座標)を示す、菱形(縁が黒い白い四角)のマーカー用ヘルパー。
   検知した震源(推定値・白丸黒縁)と見分けが付くよう、あえて別の形にして
   いる。震源推定マーカーの下に敷く前提(重なった時に検知側が見えるように、
   レイヤー追加順を推定マーカーより先にする)。
   ───────────────────────────────────────────────────── */
const TRUE_EPICENTER_MARKER_HALF_SIZE_METERS = 9000; // 菱形の中心から頂点までの距離

function buildTrueEpicenterDiamondCoords(lon, lat) {
  const latRad = lat * Math.PI / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.max(0.000001, Math.cos(latRad));
  const dx = TRUE_EPICENTER_MARKER_HALF_SIZE_METERS / metersPerDegLon;
  const dy = TRUE_EPICENTER_MARKER_HALF_SIZE_METERS / metersPerDegLat;
  // 上→右→下→左→上、の順で菱形(正方形を45度回転させた形)の頂点を結ぶ。
  return [[lon, lat + dy], [lon + dx, lat], [lon, lat - dy], [lon - dx, lat], [lon, lat + dy]];
}

// trueEpicenters: { lat, lon }[] (地震検知テストが実行中でなければ空配列)
export function buildTrueEpicenterFeatures(trueEpicenters) {
  if (!trueEpicenters || trueEpicenters.length === 0) return [];
  return trueEpicenters.map(trueEpicenter => ({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [buildTrueEpicenterDiamondCoords(trueEpicenter.lon, trueEpicenter.lat)] },
    properties: {},
  }));
}
