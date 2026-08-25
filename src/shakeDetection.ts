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
 * さらに、震度microChainIntensityCeiling(既定0.5、震度0=無感地震相当の
 * 上限と揃えている)未満のごく微小な変化に
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
 *
 * 【23節: detectedAtの遅延対策】
 * event.detectionTimesに記録するdetectedAtは、以前は「判定ルール(近傍の
 * 裏付けを含む)が確定した時刻」をそのまま使っており、震源推定
 * (epicenterEstimation.ts)がこれを到達時刻として逆算するP波/S波到達円が、
 * 実際の揺れの広がりより遅れて表示される原因になっていた。判定ルール自体は
 * 誤検知防止のためそのまま維持しつつ、各観測点ごとに「今の上昇に反応し
 * 始めた時刻」をごく緩い基準(reactionRiseThreshold等)で常時追跡しておき、
 * 実際にイベントへ追加される際はその時刻をdetectedAtとして使うように
 * 変更した(addPointToEvent参照)。
 *
 * 【誤検知対策A・B・C】観測点が密集する陸域で、地理的相関ノイズ(天候・交通振動等)
 * によりdetectionRulesの緩い条件(ルール4)が誤発火し、quick retractionでも
 * 取り消されず数十秒残る不具合への対策。
 *   A) ステップ4のゲートをmicroChainIntensityCeilingからdetectionRules専用の
 *      detectionRulesMinIntensity(0.1)に変更し、ルール4/5のminOwnIntensityが
 *      本来の設計通り機能するようにした。
 *   B) quick retraction(ステップ9)に、検知時刻から見た伝播速度の整合性チェック
 *      (computeEventSpeedConsistencyRatio)を追加。観測点数が増えていても、
 *      伝播速度が地震として妥当でなければ取り消し対象にする。
 *   C) BFS面的拡張(ステップ6)に、伝播元からの距離・時刻差に基づく伝播速度
 *      チェックを追加し、ノイズが速度を無視して際限なく面的に広がる(=Bの
 *      判定を誤魔化す)ことを防ぐ。
 */

export const DEFAULT_SHAKE_DETECTION_PARAMS = {
  // 近傍点探索(initialize時に1度だけ計算。SetupNearPoints相当)
  neighborRadiusKm: 25,        // これより近い観測点同士を「近傍」とみなす
  maxNeighbors: 8,             // 近傍点として保持する最大数(detectionRulesで
                                // 最大8点まで参照するルールがあるため)

  // 【23節】detectedAtの遅延対策: 「反応開始時刻」の追跡用の緩い基準。
  // detectionRules(近傍の裏付けを含む)が確定するまで待つと、記録される
  // detectedAtが実際にP波が到達した瞬間より数秒〜十数秒遅れてしまう
  // (震源推定・PS円描画のズレの原因になっていた)。判定ルール自体は誤検知
  // 防止のためそのまま維持しつつ、「いつのことにするか」の打刻だけを、
  // この緩い基準で常時追跡した「反応開始時刻」に差し替える(検知の確定は
  // 従来通り近傍裏付けを待つが、記録される時刻は実際の揺れ始めに近づく)。
  // microRiseThreshold/microAvgRiseThresholdよりもさらに緩い値にしている
  // (震度0以上の通常の地震でも、S波本震より前のごく初期の反応を捉えたい
  // ため)。
  reactionRiseThreshold: 0.08,     // 前tickからの上昇量がこれ以上で「反応開始」候補
  reactionAvgRiseThreshold: 0.05,  // 直近5秒平均からの上昇量がこれ以上必要(緩い版)

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

  // 無感地震等の微小な変化専用の検知経路(P波伝播速度チェック)。
  // riseThresholdには届かない微小な上昇でも、近傍点への伝播が、距離と
  // 時間差から逆算した速度としてP波の妥当な速度レンジに収まっていれば
  // 地震波の可能性が高いとみなす。ただし2点だけの速度一致は偶然の
  // 可能性があるため、3点以上の連鎖(A→B→C)で速度の一貫性が取れて
  // 初めて検知として採用する。この経路は「microChainIntensityCeiling未満」
  // の範囲でのみ、detectionRulesによる判定の代わりに使う
  // (その値以上の通常の急上昇検知には影響しない)。
  //
  // 【24節: 無感地震も検知できるように、対象範囲を拡大】
  // 以前はceilingが-1で、震度0(0〜0.5)の範囲はdetectionRulesの中で最も
  // 緩いルール(近傍8点中5点の裏付けが必要)に頼っていた。これは統計的な
  // 「多数の近傍が同時に反応しているか」に基づく判定のため、無感地震
  // (震源付近のごく少数の観測点にしか明確な反応が出ない、震度1未満の
  // ごく小さな地震)では、近傍の過半数という裏付け条件を満たせず未検知に
  // なりやすかった。P波伝播速度チェックは「多数の近傍の同時反応」を必要と
  // せず、少数の観測点間の伝播の物理的な一貫性だけで判定できるため、弱い
  // 地震の検知に向いている。levelThresholds[0](0.5、震度0とみなす上限)と
  // 揃えることで、「震度0(無感)相当の範囲は全てこの経路で判定する」という
  // 分かりやすい境界にした。
  microChainIntensityCeiling: 0.5, // この値未満を「微小な変化」として
                                    // 伝播速度連鎖経路の対象にする境界値

  // 【誤検知対策A】従来はステップ4(detectionRules評価)の対象を
  // microChainIntensityCeiling(0.5)以上に限っていたため、ルール4
  // (minOwnIntensity: 0.2)・ルール5(同0.1)の閾値が常に0.5へ上書きされ、
  // 「無感地震〜弱い揺れを厚い近傍裏付けで拾う」という設計が機能して
  // いなかった。detectionRules側の最小値(ルール5の0.1)に合わせた専用の
  // ゲートを設け、ステップ4がこの値未満の点を対象外とするようにする。
  // ステップ3(microChain)のゲートはmicroChainIntensityCeilingのまま
  // 変更しないため、震度0.1〜0.5の範囲はステップ3・ステップ4の両方で
  // 評価されることになる(元々のコメントにある「ごり押し型のアンサンブル」
  // の設計意図と整合。イベント統合ロジックにより二重登録も起きない)。
  detectionRulesMinIntensity: 0.1, // detectionRules評価の対象とする震度下限
                                    // (ルール5のminOwnIntensityに合わせる)
  tickIntervalSeconds: 1,      // 1tickが何秒に相当するか(実データの更新間隔)
  // 【24節】無感地震のごくわずかな立ち上がりも拾えるよう、23節で追加した
  // reactionRiseThreshold/reactionAvgRiseThreshold(0.08/0.05)と揃える形で、
  // 従来値(0.12/0.1)からさらに緩めた。
  microRiseThreshold: 0.08,    // 対象範囲の観測点で、これ以上の上昇があれば
                                // 「微小上昇」候補とする(riseThresholdより緩い)
  microAvgRiseThreshold: 0.06, // 直近5秒平均からの上昇量の要求値(微小版)
  pWaveMinSpeedKmS: 5.5,       // 伝播速度として妥当とみなす下限(km/s)
  pWaveMaxSpeedKmS: 8.0,       // 伝播速度として妥当とみなす上限(km/s)
                                // (shakeTestSimulation.tsのP波速度6.8km/sを中心に許容幅を持たせた値)
  microChainMinLength: 3,      // 検知として採用するために必要な連鎖の点数
                                // (対象範囲が広がった分、誤検知の抑止として
                                // ここは緩めず維持する。要調整)

  // 【25節】誤検知の素早い取り消し(quick retraction)用のパラメータ。
  // イベント作成からfalsePositiveCheckTicks以内に、(a)新たな観測点が
  // 1点も増えず、かつ(b)関与している観測点が軒並み「反応が収まった」
  // 状態(avgDiffがreactionAvgRiseThreshold未満)に戻っていれば、本物の
  // 地震ではなく単発のノイズ・瞬間的なスパイクだった可能性が高いと判断し、
  // 通常の寿命(eventDurationBaseMs、数十秒)を待たずにイベントを即座に
  // 取り消す。実際の地震は、揺れが面的に広がって観測点が増えていくか、
  // 少なくとも数秒〜数十秒は揺れが続く(shakeTestSimulation.tsの
  // HOLD_DURATION_MS等)ため、この両方が同時に起きることはまず無い。
  // 孤立トリガー(isolatedRiseThreshold、単独ですぐ確定扱いになる経路)は
  // 特に誤検知のリスクが高いため、この仕組みの主な対象になる。
  falsePositiveCheckTicks: 6, // イベント作成から何tick(≒秒)様子を見るか

  // 【誤検知対策B】quick retractionは従来「観測点数が増えていないこと」を
  // 本物判定の根拠にしていたが、観測点が密集する陸域で天候・交通振動等の
  // 地理的相関ノイズが発生すると、下のpropagationRiseThreshold(緩い基準)
  // によってBFS面的拡張が次々に近傍を巻き込み、観測点数が増え続けてしまう。
  // その結果、ノイズでも「観測点が増えた=本物」と誤判定され、取り消されずに
  // 数十秒残ってしまっていた。対策として、観測点数が増えているケースでも、
  // イベント内の検知時刻(detectionTimes)から実際の伝播速度を検証し、地震
  // として物理的に妥当な速度関係にあるペアの割合が一定基準を下回れば、
  // 取り消し対象とする。地理的相関ノイズは距離によらずほぼ同時多発になる
  // ため、速度が異常値(pWaveMaxSpeedKmS超)になりやすく、地震との差が
  // 出やすい。
  retractionSpeedConsistencyRatio: 0.5, // 妥当な速度レンジ(pWaveMinSpeedKmS〜
                                         // pWaveMaxSpeedKmS)に収まるペアの
                                         // 割合がこれ未満なら取り消し候補とする。
                                         // microChain(3点連鎖の速度整合を実質
                                         // 100%要求)ほど厳格にはせず、確定済み
                                         // イベントの取り消し判定として多少
                                         // 緩めている(detectionRulesの裏付け
                                         // 比率レンジ0.29〜0.63の中間水準)。
  retractionSpeedMinPairDistanceKm: 10, // これ未満の観測点ペアは、検知時刻の
                                         // ノイズで速度誤差が増幅されやすい
                                         // ため速度チェックの対象から除外する
                                         // (neighborRadiusKm=25kmより小さい値)。

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
                                   //
                                   // 【誤検知対策C】上記に加え、取り込み判定時に
                                   // 伝播元(current)から拡張先候補までの距離・
                                   // 時刻差から伝播速度を逆算し、pWaveMinSpeedKmS
                                   // 〜pWaveMaxSpeedKmSの範囲に収まらない場合は
                                   // 取り込まないようにする(詳細はprocessTick
                                   // ステップ6を参照)。propagationRiseThreshold
                                   // だけでは、密集地域でノイズが伝播速度を無視
                                   // して際限なく面的に広がり、Bの「観測点数が
                                   // 増えた」判定を誤魔化してしまうため。

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

// 【誤検知対策B】イベント内の観測点ペアの検知時刻(detectionTimes)から、
// 実際の伝播速度が地震波として物理的に妥当な範囲
// (pWaveMinSpeedKmS〜pWaveMaxSpeedKmS)に収まっているペアの割合を計算する。
// 距離がretractionSpeedMinPairDistanceKm未満のペアは、検知時刻のノイズで
// 速度誤差が増幅されやすいため除外する。評価対象となるペアが無ければnullを
// 返す(判定材料が無い=速度不整合とは断定できないため、呼び出し側は
// 「本物とみなす」側に倒す)。
function computeEventSpeedConsistencyRatio(event, params) {
  const detections = [...event.detectionTimes.values()];
  if (detections.length < 2) return null;
  let validCount = 0;
  let consistentCount = 0;
  for (let i = 0; i < detections.length; i++) {
    for (let j = i + 1; j < detections.length; j++) {
      const a = detections[i];
      const b = detections[j];
      const distKm = haversineKm(a.lat, a.lon, b.lat, b.lon);
      if (distKm < params.retractionSpeedMinPairDistanceKm) continue;
      const seconds = Math.abs(a.detectedAt - b.detectedAt) / 1000;
      if (seconds <= 0) continue; // 同時刻ペアは速度が定義できないため対象外
      const speedKmS = distKm / seconds;
      validCount++;
      if (speedKmS >= params.pWaveMinSpeedKmS && speedKmS <= params.pWaveMaxSpeedKmS) consistentCount++;
    }
  }
  if (validCount === 0) return null;
  return consistentCount / validCount;
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
//
// 【26節: 離島等、近傍観測点が少ない場所での検知遅延・分散への対策】
// 以前はrule.requiredNeighborCountを固定の絶対数として扱っていた
// (例: 「近傍8点中5点」なら、実際の近傍が2点しか無い場所では絶対に
// 満たせない=5点必要なルールは事実上使えない)。離島など、
// neighborRadiusKm(25km)以内に十分な数の観測点が無い場所では、
// isolatedRiseThreshold(近傍0点専用、高いしきい値で単独即時確定)の
// 対象にすらならない「近傍1〜4点」の中途半端な観測点が、どのルールも
// 満たせず検知が遅れたり、島ごとにバラバラに(検知できたとしても)
// 分散した小さいイベントになったりしていた。
// 対策として、必要人数を「候補数に対する比率」で決めるようにした。
// 近傍が豊富な場所(候補数がneighborCountちょうど)では、これまでと全く
// 同じrequiredNeighborCountになるため、既存の(十分な観測点密度がある
// 地域での)挙動には影響しない。候補が少ない場所では、その分必要人数も
// 比例して減る(ただし0にはならないよう、最低1点の裏付けは常に必要)。
function evaluateDetectionRules(point, points, rules) {
  for (const rule of rules) {
    if (rule.minOwnIntensity != null && point.latestIntensity < rule.minOwnIntensity) continue;
    if (rule.minOwnRiseRateMax10s != null) {
      if (point.riseRateMax10s == null || point.riseRateMax10s < rule.minOwnRiseRateMax10s) continue;
    }

    const candidates = point.nearPoints.slice(0, rule.neighborCount);
    if (candidates.length === 0) continue; // 近傍が無い(isolated経路の対象)

    const matchedNeighbors = [];
    for (const np of candidates) {
      const neighbor = points.get(np.id);
      if (!neighbor) continue;
      const neighborValue = rule.neighborMetric === "riseRateMax10s" ? neighbor.riseRateMax10s : neighbor.latestIntensity;
      if (neighborValue != null && neighborValue >= rule.minNeighborValue) matchedNeighbors.push(neighbor);
    }

    const requiredRatio = rule.requiredNeighborCount / rule.neighborCount;
    const requiredCount = Math.max(1, Math.ceil(candidates.length * requiredRatio));
    if (matchedNeighbors.length >= requiredCount) {
      return { matched: true, matchedNeighbors };
    }
  }
  return { matched: false, matchedNeighbors: [] };
}

let eventIdSeq = 1;

function createEvent(now, tick) {
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
    // 【25節: 誤検知の素早い取り消し】作成時のtick番号と、判定用の状態。
    // 詳細はprocessTick内の該当ステップのコメント参照。
    createdTick: tick,
    pointCountAtWindowStart: null,
    retractionCheckDone: false,
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
  // 【23節】detectedAtには、判定ルールが確定した時刻(now)ではなく、この点が
  // 実際に反応し始めた時刻(point.reactionStartAt)を使う。判定ルール自体
  // (近傍の裏付けを待つこと)は誤検知防止のためそのまま維持しつつ、記録
  // される時刻だけを実際のP波到達に近づけることで、震源推定・PS円描画の
  // ズレを減らす。reactionStartAtが無い(理論上起こらないはずだが念のため)
  // 場合はnowにフォールバックする。
  if (!event.detectionTimes.has(point.id)) {
    const detectedAt = point.reactionStartAt ?? now;
    event.detectionTimes.set(point.id, { lat: point.lat, lon: point.lon, detectedAt, level });
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
        // 【23節】この観測点が「今の上昇」に反応し始めた実時刻(ms)。
        // detectionRules(近傍の裏付けを含む)が確定するのを待たず、ごく緩い
        // 基準(reactionRiseThreshold等)で反応開始を追跡しておき、実際に
        // イベントへ追加される際にdetectedAtとして使う(addPointToEvent
        // 参照)。上昇が止まればnullに戻す(「今の上昇の開始時刻」を常に
        // 表すため)。
        reactionStartAt: prev ? prev.reactionStartAt : null,
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

      // 【23節】反応開始時刻の追跡。detectionRulesの確定を待たず、ごく緩い
      // 基準で「今まさに上がり始めているか」を毎tick判定し、上がり始めた
      // 最初のtickの実時刻を記録しておく(後でこの点がイベントに追加される
      // 際、addPointToEventがdetectedAtとしてこれを使う)。上昇が止まれば
      // nullに戻し、常に「今の上昇の開始時刻」を表すようにする。
      const reacting = value != null
        && point.intensityDiff >= params.reactionRiseThreshold
        && (point.avgDiff == null || point.avgDiff >= params.reactionAvgRiseThreshold);
      if (reacting) {
        if (point.reactionStartAt == null) point.reactionStartAt = now;
      } else {
        point.reactionStartAt = null;
      }
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
        targetEvent = createEvent(now, tick);
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

        const targetEvent = createEvent(now, tick);
        this.events.set(targetEvent.id, targetEvent);
        const level = intensityToShakeLevel(point.latestIntensity, params.levelThresholds);
        addPointToEvent(targetEvent, point, level, now, params);
        // 孤立トリガー(近傍なしで単独発火)は、単独でも高いしきい値を越えて
        // いるため、待たずにそのまま確定扱いにする。
        targetEvent.confirmed = true;
        continue;
      }

      // 【誤検知対策A】従来はmicroChainIntensityCeiling(0.5)未満を一律で
      // 除外していたため、ルール4/5の低いminOwnIntensity(0.2/0.1)が常に
      // 0.5へ上書きされていた。detectionRules専用のゲート
      // (detectionRulesMinIntensity)に変更し、震度0.1〜0.5の範囲も
      // detectionRulesで評価されるようにする(ステップ3のmicroChainとは
      // 重複して評価されるが、これは元々の「ごり押し型アンサンブル」の
      // 設計意図と整合しており、イベント統合ロジックで二重登録も起きない)。
      if (point.latestIntensity == null || point.latestIntensity < params.detectionRulesMinIntensity) continue;

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
        targetEvent = createEvent(now, tick);
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
        // 【誤検知対策C】伝播元(current)から拡張先候補までの距離・時刻差から
        // 伝播速度を逆算し、地震波として物理的に妥当な範囲
        // (pWaveMinSpeedKmS〜pWaveMaxSpeedKmS)に収まらなければ取り込まない。
        // currentの検知時刻が記録されていない(=まだイベントのdetectionTimes
        // に載っていない)場合はチェックをスキップして従来通り許可する。
        const currentDetection = event.detectionTimes.get(current.id);
        if (currentDetection) {
          const distFromCurrentKm = haversineKm(current.lat, current.lon, neighbor.lat, neighbor.lon);
          const elapsedSeconds = (now - currentDetection.detectedAt) / 1000;
          if (elapsedSeconds > 0 && distFromCurrentKm > 0) {
            const propagationSpeedKmS = distFromCurrentKm / elapsedSeconds;
            if (propagationSpeedKmS < params.pWaveMinSpeedKmS || propagationSpeedKmS > params.pWaveMaxSpeedKmS) continue;
          }
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

    // 9) 誤検知の素早い取り消し(quick retraction、25節)。作成から
    //    falsePositiveCheckTicks以内のイベントについて、(観測点が1点も
    //    増えていないか、または増えていても伝播速度が地震として妥当でない)
    //    かつ関与する観測点が軒並み反応が収まっていれば、ノイズ・瞬間的な
    //    スパイクだったとみなして即座に取り消す(通常の寿命=
    //    eventDurationBaseMsを待たない)。判定は2段階:
    //    (a) 作成の次のtickで、その時点のpointCountを基準値として記録する
    //        (作成直後は複数点が同tickでまとめて加わるため、その直後の
    //        状態を「初期の大きさ」とする)。
    //    (b) falsePositiveCheckTicks経過した時点で1回だけ判定する。
    //    【誤検知対策B】観測点が増えているケースも、以前は無条件に「本物」
    //    として除外していたが、地理的相関ノイズがBFS面的拡張で観測点数を
    //    増やし続けてしまうケースに対応するため、伝播速度の整合性チェック
    //    (computeEventSpeedConsistencyRatio)を追加した。
    for (const event of this.events.values()) {
      if (event.retractionCheckDone) continue;
      const ticksSinceCreated = tick - event.createdTick;
      if (event.pointCountAtWindowStart == null) {
        if (ticksSinceCreated >= 1) event.pointCountAtWindowStart = event.pointCount;
        continue;
      }
      if (ticksSinceCreated < params.falsePositiveCheckTicks) continue;

      event.retractionCheckDone = true;
      const pointsIncreased = event.pointCount > event.pointCountAtWindowStart;
      if (pointsIncreased) {
        // 【誤検知対策B】従来は観測点が増えていれば無条件に「本物」として
        // scrubをスキップしていたが、密集地域では地理的相関ノイズ(天候・
        // 交通振動等)でもBFS面的拡張(propagationRiseThreshold)により
        // 観測点数が増え続けてしまい、この条件だけでは誤検知を取り消せない
        // ケースがあった。観測点数が増えている場合でも、検知時刻から見た
        // 伝播速度が地震として妥当な範囲に収まっているか(=speedConsistency)
        // を追加で確認し、妥当と言えない場合は下のstillReacting判定に委ねる。
        const speedConsistency = computeEventSpeedConsistencyRatio(event, params);
        const speedConsistent = speedConsistency == null || speedConsistency >= params.retractionSpeedConsistencyRatio;
        if (speedConsistent) continue; // 観測点が増え、伝播速度も整合→本物とみなす
      }

      let stillReacting = false;
      for (const id of event.pointIds) {
        const p = points.get(id);
        if (p && p.avgDiff != null && p.avgDiff >= params.reactionAvgRiseThreshold) {
          stillReacting = true;
          break;
        }
      }
      if (stillReacting) continue; // まだ反応が続いている→本物とみなす

      // 取り消し: 関与していた観測点を解放し(誤検知の残骸を引きずらない、
      // 本当に揺れ始めた場合は改めて新規イベントとして検知できるようにする)、
      // イベント自体を削除する。
      for (const id of event.pointIds) {
        const p = points.get(id);
        if (p && p.eventId === event.id) p.eventId = null;
      }
      this.events.delete(event.id);
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
