/**
 * epicenterEstimation.ts
 * ------------------------------------------------------------
 * 揺れ検知イベント(shakeDetection.tsのShakeDetectionEngineが生成するイベント)
 * から、検知時刻・震度(揺れの広がり方・その方向)を手がかりにして震源
 * (緯度・経度・深さ・発生時刻)を推定する。
 *
 * 参考文献:
 * - 「揺れ検知から震央を検出してみる」(https://note.com/kotoho7/n/n59e423877b1b)
 *   のGeiger法ベースの自己流アルゴリズムを当初のベースにした。
 * - 堀内ほか(2007)「緊急地震速報のための即時震源決定手法の開発と今後の課題」
 *   物理探査60(5), 399-406。着未着法(式(1))・解の安定性チェックの考え方。
 * - 気象庁地震火山部「緊急地震速報の概要や処理手法に関する技術的参考資料」
 *   (平成20年7月29日)。グリッドサーチ法(探索範囲の絞り方・全数探索)・
 *   テリトリー法・検知点数が少ない場合の深さの扱い。
 *
 * 【アルゴリズムの概要】
 *   - 初期仮震源(グリッド中心): 検知済み観測点を震度で重み付けした重心
 *     (震度が高い観測点ほど震源に近いはず、という直感)。震度データが無い
 *     場合は最初に検知した観測点にフォールバックする。
 *   - 探索: 気象庁のグリッドサーチ法を参考に、グリッド中心から水平方向に
 *     2度以内の範囲を、粗い間隔→細かい間隔(0.1度)の2段階で全数探索する
 *     (反復移動=局所探索ではなく、全数探索にすることで開始点への依存を
 *     無くしている。詳細は定数のコメント参照)。
 *   - 深さ: 検知点数が少ない間は気象庁のテリトリー法にならい固定(10km)、
 *     ある程度増えたら気象庁のグリッドサーチ法にならい上限付きで探索する
 *     (詳細はbuildDepthCandidatesのコメント参照)。
 *   - 誤差レベル: 到達時刻の重み付き分散に加えて、shakeTestSimulation.tsの
 *     震度減衰式(calcPeakIntensity)を使い、観測された震度パターンを最も
 *     よく説明できるマグニチュードを探索し、その残差をペナルティとして
 *     加算する(computeAmplitudeCalibrationPenalty)。単純な「震度と距離の
 *     順序が合っているか」の相関ではなく実際の非線形な減衰カーブを使うことで、
 *     観測点が一方向(陸側)に偏る沖合の地震でも、震源までの絶対距離に
 *     制約がかかるようにしている。
 *   - 着未着法: 未検知観測点iについて、理論到達時刻Tiと現在時刻Tnowの間に
 *     Tnow−Ti＜0が成立するはず、という制約(堀内ほか, 2007の式(1))を、
 *     違反時の残差εi=Tnow−Tiを2乗して到達時刻の分散と同じ目的関数に
 *     加算する形で実装している。
 *   - 一意性チェック: 細かいグリッド探索で実際に評価済みの候補群の中から、
 *     最良解と十分離れた場所にほぼ同じくらい良い候補が無いかを調べる
 *     (堀内ほか, 2007の解の安定性チェックを参考。追加の評価コストなしで
 *     既存の探索結果から判定できる)。
 *   - 収束判定: `EpicenterEstimator`が「検知点数が一定以上」「推定位置が
 *     しばらく動いていない(時間経過ベース)」「一意性チェックを満たす」の
 *     3条件すべてを満たすまでconfirmed: falseを返す。
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
 * - 探索範囲をグリッド中心から2度以内に限定し、さらに粗い間隔→細かい間隔の
 *   2段階探索にすることで、気象庁と同じ0.1度刻みの分解能を保ちつつ評価
 *   候補数を現実的な数に抑えている(詳細はGRID_SEARCH_RADIUS_DEG等の
 *   コメント参照)。
 * - 検知点数が数百点規模に増えても計算コストが頭打ちになるよう、実際の
 *   誤差レベル計算にはグリッド中心に近い上位MAX_STATIONS_FOR_ESTIMATION点
 *   だけを使う(堀内ほか, 2007の「近傍20観測点程度に絞る」設計を参考)。
 *   探索範囲自体を2度以内に構造的に限定したことで、この部分集合を
 *   グリッド中心を基準に1回だけ選べば探索範囲全体をカバーできる(以前の
 *   反復移動方式では、候補が大きく動きうるため各ステップで選び直す必要が
 *   あった)。
 * - 着未着法(未検知観測点のチェック)は、グリッド中心からUNDETECTED_
 *   STATION_PREFILTER_RADIUS_KM以内の観測点だけを対象にする。
 *
 * 【検知点数が多い時に震源が沖合・深部へ暴走する不具合への対策(実運用報告
 *   を踏まえた追加修正)】
 * 実際のアプリで、検知点数が100点超に増えた際に震源が実際より大幅に沖合
 * (西)・深部(探索上限の150km)にずれる不具合が報告された。原因は、
 * 震源から遠い(情報量の乏しい)弱い観測点が大量に検知に加わると、個々の
 * 重みが小さくても合計では近傍の少数の高震度観測点を上回ってしまい、震源が
 * 観測点の「量」に引きずられること。対策として、(1) weightForDistanceを
 * 反比例から二乗に変更して遠方観測点の影響をより強く抑える、(2)
 * MAX_STATIONS_FOR_ESTIMATIONを100→50に引き下げる、(3) 深さの探索結果が
 * 探索上限ちょうどに張り付いた場合(＝谷が探索範囲の外にある退化的な解の
 * 疑いが強い)はuniquenessConfirmedをfalseにして収束扱いにしない、の3点を
 * 実施した。
 *
 * 【上記の対策後も、震源が海域(観測網の外側)にある地震だけ誤差が大きく
 *   残る不具合への追加対策(20節で置き換え済み、以下は経緯)】
 * 上記3点の対策後の実運用報告で、震源が内陸の場合は良好に収束する一方、
 * 震源が海域(観測点が片側=陸側にしか無い)の場合は依然として水平誤差
 * 100km超が残るケースが確認された。原因は「弱い遠方観測点の量」ではなく、
 * 観測点が片側にしか無いこと自体(反対方向の裏付けとなるデータが構造的に
 * 存在しない)。対策として、検知点群の方位角分布から「片側偏り」の度合いを
 * 判定し、偏りが大きいほどグリッド中心から離れた候補に懐疑的になる正則化
 * (ソフトな加算ペナルティ)を誤差レベルに追加した。
 *
 * 【20節: グリッド中心の見直し・片側偏り補正のハード化(のちに撤去)】
 * 上記のソフトな正則化を導入した後も、(a) 海域の震源で誤差100km超が
 * 残るケースが続いたこと、(b) むしろ内陸の震源でも推定が海側にズレる
 * 退行が新たに確認されたこと、の2点が実運用で報告された。(b)の原因として、
 * グリッド中心(震度重み付き重心)自体が観測点配置(検知点が陸側だけ)に
 * よって系統的にズレており、ソフトな正則化がその「ズレた中心」への
 * 収束を後押ししてしまっていた可能性が疑われた。対策として、
 * (1) グリッド中心を、震度重み付き重心から「最初に検知した観測点」
 * (気象庁のグリッドサーチ法と同じ)に変更し、単一観測点の系統的バイアス
 * の少なさを活かす、(2) 片側偏り補正を、誤差レベルへの加算(ソフト)から、
 * 空白方位側の候補をそもそも探索対象から除外する制約(ハード)に変更する、
 * の2点を実施した。
 *
 * 【方位角分布に基づく片側偏り補正の撤去】
 * (2)のハードな制約(方位角ギャップに基づく候補除外)は、その後の指示により
 * いったん撤去した。しばらくは(1)のグリッド中心の変更(最初に検知した観測点を
 * 中心にする)のみが有効で、方位角分布関連の判定・除外は行っていなかった。
 *
 * 【23節: テリトリー法ベースの観測点分類を使った、片側偏り補正の再導入
 *   (ハード除外ではなくソフトな重み強化として)】
 * 撤去前のハードな候補除外は「内陸震源が海側にズレる」退行を招いた。同じ
 * 失敗を避けるため、今回は候補を探索対象から除外する・距離に応じて懐疑的に
 * するといった位置そのものへの直接的な操作はせず、既存の震度較正ペナルティ
 * (computeAmplitudeCalibrationPenalty、揺れの広がり方=物理的な減衰カーブに
 * 基づく、震源までの絶対距離への制約)の重みだけを、観測点配置が片側に
 * 偏っている度合いに応じて動的に強める形にした。震度較正ペナルティは
 * それ自体が実際の観測データ(震度パターン)に基づく制約のため、これを
 * 強めても「その方向に押し出す」ような人為的なバイアスにはならず、単に
 * 「距離の裏付けをより厳しく求める」だけで済む。
 *
 * 判定は2段構えにしている(stationTerritory.tsのgetStationTerritories()を
 * 使う)。
 *   (a) 静的なゲート: 最初に検知した観測点(grid中心)が観測点マスタ全体の
 *       凸包上(外部点・孤立点)にあるかどうかを、起動時に一度だけ計算済みの
 *       分類から即座に判定する。内部点(interior)なら、そもそも観測網に
 *       構造的な片側偏りが生じ得ない場所のため、以降のゲイン計算自体を
 *       スキップする(=このイベントでは何もせず、既存の挙動のまま)。
 *       これにより、検知点数が少ない早い段階でたまたま片側にしか検知が
 *       無いだけの内陸イベントまで過剰に反応してしまう(＝撤去前と同種の
 *       退行を再発させる)ことを避けている。
 *   (b) 動的な重み: (a)を通過した(=観測網の縁にあたる)イベントについてのみ、
 *       今回実際に検知した観測点群の方位角ギャップ(グリッド中心から見た
 *       各観測点の方位を並べた時の最大の隙間)を計算し、180度(=半円)を
 *       超える分だけ震度較正ペナルティの重みを最大AMPLITUDE_GAP_MAX_
 *       MULTIPLIER倍まで強める。ギャップが無い(観測点が全周を囲んでいる)
 *       場合は倍率1倍で、以前の挙動と変わらない。
 *
 * 【23節・実装時の検証結果(重要)】
 * ギャップの基準点は、当初グリッド中心(最初に検知した陸上観測点)にして
 * いたが、これだと震源が海域にあっても基準点自体は内陸まで広がる観測網の
 * 中に埋もれているため方位角ギャップが小さく出てしまい、ほぼ発動しない
 * ことを確認した。粗い探索の最良点(coarseBest、実際の到達時刻・震度に
 * ある程度反応済みの位置)を基準点にする形に直したことで、ギャップは
 * 正しく検出できるようになった(合成データでの検証で300度超のギャップを
 * 正しく検出)。
 * 一方で、震度較正ペナルティの重みをAMPLITUDE_GAP_MAX_MULTIPLIER倍(今回は
 * 3倍)しても、到達時刻分散の項(errorLevelの支配項、震度較正ペナルティより
 * 4〜5桁大きい)に対して震度較正ペナルティの寄与自体が小さすぎるため、
 * 最終的な最良解にはほとんど影響しないことも、合成データでの検証(タイミング
 * ノイズ・震度ノイズを与えた複数シナリオ)で確認した。倍率を100〜100000倍
 * まで極端に引き上げても、真の震源(海域)側へ寄り切らないケースがあった
 * (=単純な重み倍率の引き上げだけでは、本質的な解決に至らない)。
 * このため現時点では、倍率は保守的な値(3倍)のまま、明らかな片側偏りが
 * ある場合の「わずかな後押し」程度の効果にとどめている。到達時刻分散の
 * 項自体の重み付け(観測点配置による偏りの補正)や、震度較正ペナルティの
 * 重み(AMPLITUDE_PENALTY_WEIGHT)自体の見直しなど、より本質的な対策は
 * 今後の課題として残る。
 *
 * 【24節: coarse探索のマルチスタート化】
 * coarseの最良点1つだけをfineに渡す従来の方式だと、coarseの簡易評価
 * (到達時刻の分散のみ)がわずかに陸寄りを有利と誤判定した場合、fineは
 * その周辺(±0.6度)しか探索できず真の解(海域側)に抜け出せない。coarseの
 * 評価候補から、互いに十分離れた(一意性チェックと同じ基準: 水平
 * UNIQUENESS_MIN_DISTANCE_KM以上、または深さUNIQUENESS_MIN_DEPTH_DIFF_KM
 * 以上)局所解を貪欲法で最大MULTISTART_MAX_CANDIDATES個選び、それぞれを
 * 独立にfine探索して最良のものを採用する。23節の片側偏り補正も、開始点
 * ごとに個別に(方位角ギャップを開始点基準で)計算し直す。
 * 検知点数が増えるほど到達時刻の分散だけでも解が絞り込まれやすくなり
 * マルチスタートの必要性は下がる一方、fine探索のコストはK倍になるため、
 * 検知点数がMULTISTART_MAX_POINTS未満の検知初期だけ有効にする(検知点数が
 * 増えたら従来通りcoarseBest1点だけの軽量な経路に戻る)。
 */

import { P_WAVE_SPEED_KM_S, S_WAVE_SPEED_KM_S, calcPeakIntensity } from "./shakeTestSimulation";
import { getStationTerritories } from "./stationTerritory";

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
// 過ぎてしまう。着未着法のペナルティ(到達時刻の残差と同じms²単位)と同程度〜
// やや強めのオーダーを目安に、暫定的にこの値にしている(要調整)。
const AMPLITUDE_PENALTY_WEIGHT = 4000;
// マグニチュード探索の最低点数(点数が少なすぎると最良マグニチュードの
// フィットが不安定になるため)。
const MIN_POINTS_FOR_AMPLITUDE_CHECK = 3;

// 【23節: 片側偏り補正(震度較正ペナルティの動的な強化)】
// グリッド中心(最初に検知した観測点)から見た検知点群の方位角ギャップが
// この角度(度)を超えた分だけ、震度較正ペナルティの重みを強める。180度
// (=検知点群がちょうど半円に収まる)までは、通常の観測点配置でも自然に
// 起こりうる範囲とみなし、倍率を上げない。
const GAP_PENALTY_THRESHOLD_DEG = 180;
// 方位角ギャップが最大(360度に近い、＝ほぼ一方向にしか観測点が無い)場合の
// 震度較正ペナルティの倍率の上限。値が大きいほど「距離の裏付け」を厳しく
// 求めるようになるが、大きすぎると震度データ自体のノイズに引っ張られ
// 過ぎる懸念があるため、暫定的にこの値にしている(要調整)。
const AMPLITUDE_GAP_MAX_MULTIPLIER = 3;

// 【B: S-P時間差ペナルティの片側偏り時強化】23節と同じ考え方だが、S-P時間差
// ペナルティは元々到達時刻分散と同オーダーで既に十分な影響力を持っている
// (23節の震度較正ペナルティは4〜5桁小さく、倍率を上げてもほぼ効果が
// 無いことを実験で確認済み)。そのため、ここでの倍率は震度較正ペナルティ
// (最大3倍)より控えめにし、S-P時間差データ自体のノイズ(観測点ごとの
// 立ち上がり検出のブレ)に過度に引っ張られないようにする。
const SP_TIME_GAP_MAX_MULTIPLIER = 2;

// 【A: 片側偏り時の探索範囲の非対称拡張】通常の探索範囲(GRID_SEARCH_RADIUS_
// DEG、2度)は、真の震源がそれより遠い(または境界ぎりぎり)場合、原理的に
// 候補にすら入らない。stationTerritory.tsが事前計算しているoutwardBearingDeg
// (観測網の外向き方位、＝海側等の可能性が高い方角)の方向だけ、この値まで
// 探索範囲を広げる。23節・Bと同じ静的ゲート(最初の観測点が観測網の外部点/
// 孤立点)を満たす場合のみ発動するため、内陸の一般的なイベントの探索コストは
// 変わらない。
const EXTENDED_GRID_SEARCH_RADIUS_DEG = 3.5;

// 【C: 検知済み観測点の早着(理論上あり得ない検知)への追加ペナルティ】
// 着未着法(未検知観測点向け、UNDETECTED_CHECK_MAX_POINTS等で足切りあり)の
// 検知済み観測点版。候補の想定発生時刻(全検知点の加重平均)からの走時では
// 「まだP波が届いていないはず」の段階で、実際にはもう検知している観測点が
// あれば、それは物理的に矛盾した候補であることを意味する。検知が予測より
// 遅いこと(検知遅延・閾値判定のブレなどで普通に起こりうる)とは非対称に
// 扱いたいため、到達時刻分散の残差が負(早着側)の場合だけ同じ値をもう一度
// 加算する。特別な倍率定数を設けず到達時刻分散と全く同じ単位で計算する
// (=実質2倍の重みになる)ため、この対策専用の重み定数は無い。着未着法と
// 異なり、追加コストが軽い(新規の観測点データ取得が不要、既存ループの
// 中で完結する)ため、点数・経過時間による足切りをせずcoarse・fine両方の
// 段階から常時有効にしている(computeCoarseErrorLevel・computeErrorLevel
// 内、それぞれのコメント参照)。

// 【対策: 深さの推定誤差がとても大きい問題】震度(振幅)だけでは、深さを
// 深く・マグニチュードを大きくしても近傍観測点での震度パターンがほとんど
// 変わらずに説明できてしまう(地震学で知られる深さ-マグニチュードの
// トレードオフ)ため、深さが一意に定まりにくい。S-P時間差(初期微動継続
// 時間)は震源距離(≒深さ)に直接的に依存する、震度パターンとは独立した
// 手がかりのため、追加のペナルティ項として使う
// (shakeDetection.tsのsWaveDetectedAt、点ごとのP波相当(detectedAt)・
// S波相当(sWaveDetectedAt)の到達時刻差を使う)。
// 到達時刻の分散(ms²単位)と同じ単位・オーダーで計算しているため、
// AMPLITUDE_PENALTY_WEIGHTのような特別な倍率は基本的に不要(1.0を基準に
// 調整用として残してある)。
const SP_TIME_PENALTY_WEIGHT = 1.0;
// S-P時間差ペナルティの最低点数(点数が少なすぎると、たまたまの観測点
// ごとのブレに引っ張られやすいため)。
const MIN_POINTS_FOR_SP_TIME_CHECK = 3;

// 震度で重み付けした重心(グリッド中心)を計算する際、上位何点までを使うか。
// 理由はcomputeAmplitudeWeightedCentroidのコメントを参照。
const CENTROID_TOP_K = 15;
// 「観測された震度パターンに最も合うマグニチュード」を粗く探索するための
// 候補値。0.5刻み(旧実装は[3.5,4.5,5.5,6.5,7.5]という1.0刻みの配列になって
// おり、コメントと実装が食い違っていた不具合を修正)。精度はあくまで粗く、
// マグニチュードそのものの推定精度を目的にしていない点は変わらない。
const CALIBRATION_MAGNITUDE_CANDIDATES = [3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 6.5, 7.0, 7.5];
// 【推定マグニチュードの表示対応】上記はグリッド探索中(候補位置ごと)に
// 何度も評価されるコストの都合上、0.5刻みの粗い候補にしている。最終的に
// 選ばれた1つの候補震源についてだけ、ユーザーへ表示する推定マグニチュード
// を求める際は、探索コストを気にする必要が無い(1回しか呼ばない)ため、
// より細かい0.1刻みの候補で評価し直す。
const FINAL_MAGNITUDE_CANDIDATES = (() => {
  const arr = [];
  for (let m = 3.0; m <= 8.0 + 1e-9; m += 0.1) arr.push(Math.round(m * 10) / 10);
  return arr;
})();

// 震源推定として意味のある最低検知点数(これ未満はnullを返す)
const MIN_DETECTION_POINTS = 2;

/* ─────────────────────────────────────────────────────
   グリッドサーチ(気象庁「緊急地震速報の概要や処理手法に関する技術的参考
   資料」のグリッドサーチ法を参考)
   ───────────────────────────────────────────────────── */

// 探索範囲(グリッド中心からこの度数以内)。気象庁のグリッドサーチ法は
// 「最初に検知した観測点から2度以内」に探索範囲を限定している。当アプリの
// 旧実装(反復移動+初期仮震源から600km以内という緩い安全弁)では、実際の
// アプリで海域の地震が数百km単位でずれる不具合が解消されなかったため、
// 気象庁の実運用に合わせて2度まで厳格化した。
const GRID_SEARCH_RADIUS_DEG = 2.0;

// 粗い探索の間隔。2.0÷0.4=5なので、-2.0〜+2.0を0.4刻みで1辺11グリッド、
// 計121グリッド(×深さ候補数)を全数評価する。
const COARSE_GRID_STEP_DEG = 0.4;

// 細かい探索の間隔(気象庁と同じ0.1度)。粗い探索の最良点の周辺だけをこの
// 間隔で細かく探索する2段階方式にしている。
//
// 【なぜ2度四方をいきなり0.1度刻みで全数探索しないか】
// 気象庁の実装(堀内ほか, 2007)は、震央距離計算のテイラー近似・走時表化等の
// 専用の高速化を行っており、多数の候補を高速に評価できる前提と考えられる。
// 当アプリのcomputeErrorLevel(マグニチュード探索・着未着法を含む)は1回の
// 評価コストがそれなりに大きいため、2度四方を一律0.1度刻みで全数探索する
// (候補数は水平だけで1辺41グリッド=1681、深さを掛けると数千〜1万超)と
// 実用的な速度を保てない。そこで粗い間隔でまず全体を見渡し、有望な領域
// だけを気象庁と同じ分解能(0.1度)で細かく探索する。
const FINE_GRID_STEP_DEG = 0.1;

// 細かい探索を行う範囲(粗い探索の最良点からこの度数以内)。粗い探索の間隔
// (0.4度)より広く取り、粗い探索の格子の隙間に真の最良点があった場合でも
// 細かい探索で拾えるようにしている。
const FINE_GRID_RADIUS_DEG = 0.6;

/* ─────────────────────────────────────────────────────
   深さの探索候補(気象庁のテリトリー法・グリッドサーチ法における、検知点数
   に応じた深さの扱いを参考)
   ───────────────────────────────────────────────────── */

// 検知点数がこれ以下の間は、深さをINITIAL_DEPTH_KM(10km)に固定する
// (探索しない)。気象庁のテリトリー法(1〜2点処理)は、この段階では深さを
// 決定せず「防災対応の観点から揺れの強さが大きく算出される10km」に固定
// している。当アプリでも、検知点数が少ない間に深さまで探索しようとすると、
// 緯度経度の探索が深さの初期値のズレに引っ張られて誤った方向へ向かう
// 不安定さが13節・14節の検証で確認されているため、そもそも動かさない
// ことでこれを回避する。
const FEW_POINTS_MAX_FOR_FIXED_DEPTH = 2;

// 検知点数がこれ以下の間は、深さの探索上限をSOME_POINTS_MAX_DEPTH_KMに
// 制限する。気象庁のグリッドサーチ法(3〜5点処理)は「3、4点処理では130km
// より深い候補は震源決定に用いない」としている(複数観測点でほぼ同時刻に
// 検知された場合、浅い直下型地震を遠方の深発地震と誤認するのを防ぐため)。
const SOME_POINTS_MAX_FOR_DEPTH_CAP = 4;
const SOME_POINTS_MAX_DEPTH_KM = 130;

// 検知点数が十分に増えた場合の深さ探索上限。日本近海で震度5弱以上の
// 被害をもたらす地震は深さ120kmを超えて観測されたことがほぼ無いとされる
// ため、余裕を見て150kmを上限にしている。
const MANY_POINTS_MAX_DEPTH_KM = 150;

// 検知点数に応じた深さ探索の上限(km)を返す。buildDepthCandidates()と
// estimateEpicenter()の「深さが探索上限に張り付いていないか」チェックの
// 両方から参照する共通ロジック(元はbuildDepthCandidates内に直書きして
// いたが、チェック側でも全く同じ判定基準が必要になったため関数化した)。
// 検知点数がFEW_POINTS_MAX_FOR_FIXED_DEPTH以下の間は深さを固定するため
// nullを返す(＝「上限に張り付く」という概念自体が当てはまらない)。
function maxDepthForPointCount(pointCount) {
  if (pointCount <= FEW_POINTS_MAX_FOR_FIXED_DEPTH) return null;
  return pointCount <= SOME_POINTS_MAX_FOR_DEPTH_CAP ? SOME_POINTS_MAX_DEPTH_KM : MANY_POINTS_MAX_DEPTH_KM;
}

// 粗い探索・細かい探索それぞれで使う深さ候補のリストを、検知点数に応じて
// 返す。stageは"coarse"または"fine"、coarseBestDepthKmは"fine"の場合のみ
// 使う(粗い探索で見つかった最良深さ)。
function buildDepthCandidates(pointCount, stage, coarseBestDepthKm) {
  if (pointCount <= FEW_POINTS_MAX_FOR_FIXED_DEPTH) {
    return [INITIAL_DEPTH_KM];
  }
  const maxDepth = maxDepthForPointCount(pointCount);
  if (stage === "coarse") {
    return [10, 50, 90, 130].filter(d => d <= maxDepth);
  }
  const offsets = [-20, -10, 0, 10, 20];
  const candidates = [...new Set(offsets.map(o => coarseBestDepthKm + o).filter(d => d >= 0 && d <= maxDepth))];
  return candidates.length > 0 ? candidates : [Math.min(coarseBestDepthKm, maxDepth)];
}

/* ─────────────────────────────────────────────────────
   検知点・未検知観測点の絞り込み(性能対策)
   ───────────────────────────────────────────────────── */

// 誤差レベル計算に実際に使う観測点数の上限(堀内ほか, 2007の「近傍20観測点
// 程度に絞って計算する」設計を参考)。検知点数が数百点規模に増えると、
// 候補ごとの評価コストが検知点数に比例して増え続け、1回の推定に200ms超
// かかることを計測で確認した(検知点数500点・全観測点4000点超の条件)。
// 震源決定に使う情報量は震源から遠い観測点ほど(weightForDistanceで重みが
// 小さくなる分)相対的に乏しいため、グリッド中心に近い観測点から優先的に
// 選んだ上位N点だけを計算に使うようにし、検知点数が増えてもコストが
// 頭打ちになるようにしている。
//
// 探索範囲をGRID_SEARCH_RADIUS_DEG(2度)以内に限定したことで、グリッド
// 中心を基準に1回だけ選んだ部分集合で探索範囲全体をカバーできる(以前の
// 反復移動方式では候補位置が大きく動きうるため、各ステップで候補位置を
// 基準に選び直す必要があった。そうしないとノイズを含む実データに近い条件で
// 絞り込み無しの場合よりかえって大きく発散する=最大337kmの不具合を検証で
// 確認していた)。
// (pointCountとして返す検知点数そのものは、この絞り込みの影響を受けず
// 実際の検知点数を返す。)
//
// 【100点→50点に引き下げ】
// weightForDistanceを二乗にしたことで遠方観測点1点あたりの影響力は
// 抑えられたが、実運用の報告(検知点数112点で誤差181km)では、それでも
// 「弱い遠方観測点の数の多さ」自体が無視できない規模だった。堀内ほか,
// 2007の「近傍20観測点程度」により近づけつつ、極端な絞り込みによる
// 情報不足(検知点が少ない早い段階の精度低下)とのバランスを取り、
// 50点を暫定値とする(要調整)。
const MAX_STATIONS_FOR_ESTIMATION = 50;

// 着未着法で未検知観測点を探す範囲の上限(km)。全観測点マスタが全国規模
// (数千点)の場合、候補ごとに全点との距離を計算すると非常に重くなるため、
// グリッド中心を基準にこの距離以内にある未検知観測点だけを候補リストとして
// 絞り込んでおく。探索範囲(2度、方位によって概ね180〜220km)に、着未着法
// 自体の探索マージン(UNDETECTED_CHECK_MARGIN_KM)と余裕を足した値。
const UNDETECTED_STATION_PREFILTER_RADIUS_KM = 250 + UNDETECTED_CHECK_MARGIN_KM;

/* ─────────────────────────────────────────────────────
   収束判定・一意性チェック
   ───────────────────────────────────────────────────── */

// 「収束判定」(EpicenterEstimatorのconfirmedフラグ)用のパラメータ。
// 検知点数が少ない早い段階では、震源推定は大きくぶれることがある(実データに
// 近い条件での検証で、震源から150km以上沖の大きめの地震では、検知点数が
// 20点程度に増えるまで推定位置が100km以上動くケースを確認済み)。そのため、
// 「検知点数が一定以上」かつ「推定位置がしばらく動いていない」の両方を
// 満たすまでは、地図上でも「参考値」であることが分かるよう薄く表示する
// (App.jsx側のconfirmedプロパティで判定)。
const CONVERGENCE_STABLE_MS = 5000; // この時間、推定位置が動かなければ「安定」とみなす
const CONVERGENCE_POSITION_TOLERANCE_KM = 10; // この距離未満の移動は「動いていない」とみなす
// 【対策: 深さの推定誤差がとても大きい問題】以前はここが緯度経度のみを
// 追跡しており、深さが毎tick大きく(例: 0km↔110km)揺れ動いていても、
// 緯度経度さえ安定していればconfirmed: trueになってしまっていた。深さも
// 同様に「動いていない」とみなす許容範囲を設け、安定判定に含める。
// FINE_GRID_STEP_DEG刻みの細かい探索でのdepthKm候補間隔(fineステージの
// offsets=[-20,-10,0,10,20])より少し広めにして、隣接候補間の小さな
// ジッターだけでは安定判定がリセットされ続けないようにしている。
const CONVERGENCE_DEPTH_TOLERANCE_KM = 15; // この深さ変化未満は「動いていない」とみなす
const MIN_CONFIRMED_POINTS = 8; // 検知点数がこれ未満の間は、安定していてもconfirmedにしない

// 「解の一意性チェック」(堀内ほか, 2007を参考)用のパラメータ。細かい
// グリッド探索(FINE_GRID_STEP_DEG刻み)で実際に評価した候補群の中から、
// 最良解からUNIQUENESS_MIN_DISTANCE_KM以上離れた候補を対象に、誤差レベルが
// 最良解のUNIQUENESS_RATIO_THRESHOLD倍以内のものが無いかを調べる。あれば
// 「たまたま一番良かっただけ」で一意に定まっているとは言えないと判断し、
// uniquenessConfirmed: falseとする。細かいグリッド探索で既に評価済みの
// 候補を再利用するため、追加の計算コストはほぼゼロ(以前の実装は最良解の
// 周囲に専用の90点グリッドを追加で評価していたが、その必要が無くなった)。
// 最良解のごく近傍(細かいグリッド探索の間隔0.1度=概ね11kmの、数グリッド分
// 程度)は、そもそも滑らかな誤差曲面の同じ谷の中にある「同じ解の一部」と
// みなして除外する距離。当初15kmで試したところ、実データに近いノイズを
// 含む条件で、単に隣接するグリッド点(0.1度刻みで2マス分、約17.5km)が
// 最良解よりわずかに(1割強)誤差が大きいだけで「別の解」と誤判定され、
// 一意性チェックが常に不成立になる(＝いつまでもconfirmedにならない)ことを
// 確認した。滑らかな誤差曲面では最良解に近いグリッド点ほど誤差が近くなるのは
// 当然であり、これは「本当に別の、比較可能な良さの解が存在する」ことを
// 意味しない。そこで、細かいグリッドの間隔より十分大きい40kmまで緩和し、
// 本当に離れた場所にある別解だけを検出するようにしている。
const UNIQUENESS_MIN_DISTANCE_KM = 40;
// 誤差レベルがこの倍率以内なら「ほぼ同じくらい良い」とみなす。
const UNIQUENESS_RATIO_THRESHOLD = 1.3;
// 【対策: 深さの推定誤差がとても大きい問題】以前は一意性チェックが
// haversineKm(水平距離)のみで判定しており、「緯度経度はほぼ同じだが
// 深さだけ大きく異なる」候補同士(震度パターンはマグニチュードの調整で
// 深さの違いをある程度吸収できてしまう、地震学でよく知られる深さ-
// マグニチュードのトレードオフ)を一切検出できなかった。水平距離が
// UNIQUENESS_MIN_DISTANCE_KM未満でも、深さの差がこれ以上あれば「別解」
// とみなすようにする。fineステージの探索候補間隔(offsets=[-20,-10,0,
// 10,20])を踏まえ、コースステージの候補間隔(40km、[10,50,90,130])より
// 十分狭いが、fine探索のジッターだけでは誤って「別解」と判定しない程度の
// 値にしている。
const UNIQUENESS_MIN_DEPTH_DIFF_KM = 30;

// 【24節: coarse探索のマルチスタート化】
// 通常はcoarse探索の最良点1つだけをfine探索(±0.6度)に渡すため、coarseの
// 簡易評価(到達時刻の分散のみ、着未着法・23節の片側偏り補正なし)がわずかに
// 陸寄りを有利と誤判定すると、fineはその周辺しか見られず真の解(海域側)に
// 抜け出せない。これに対処するため、coarseで見つかった上位の局所解を
// MULTISTART_MAX_CANDIDATES個までfineに独立して渡し、最終的に一番誤差の
// 小さいものを採用する。
//
// ただし検知点数が多くなるほど(＝時間が経ち観測点が揃うほど)到達時刻の
// 分散だけでも解が絞り込まれやすくなり、マルチスタートの必要性は下がる
// 一方、fine探索のコストはMULTISTART_MAX_CANDIDATES倍になる。検知点数が
// 少ない検知初期だけ有効にし、MULTISTART_MAX_POINTS点に達したら通常の
// (coarseBest1点だけの)探索に戻す。UNDETECTED_CHECK_MAX_POINTSと同じ値に
// しているが、着未着法とは別の目的の値のため、あえて別定数にしている。
const MULTISTART_MAX_POINTS = 30;
// マルチスタート時にfineへ渡す、coarseの局所解の最大数(K)。
const MULTISTART_MAX_CANDIDATES = 3;
// coarseの候補群から「別の局所解」を貪欲に選ぶ際の距離しきい値。一意性
// チェック(UNIQUENESS_MIN_DISTANCE_KM/UNIQUENESS_MIN_DEPTH_DIFF_KM)と
// 「同じ谷の中の点を別解として数えない」という考え方が同じため、そのまま
// 流用する。

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 2点間の方位角(真北0度、時計回り、度)。stationTerritory.tsのbearingDegと
// 同じ内容だが、共有のユーティリティファイルを作らない(このアプリの
// 既存ファイルもhaversineKm等を各ファイルで個別に持つ方針)方針に合わせて
// ここにも個別に置く。
function bearingDeg(lat1, lon1, lat2, lon2) {
  const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const theta = Math.atan2(y, x);
  return (theta * 180 / Math.PI + 360) % 360;
}

// 【23節】グリッド中心(centerLat/Lon)から見た検知点群の方位角ギャップ
// (最大の隙間、度)を計算する。検知点が少ない(1点以下)場合は「全周が
// 空白」とみなしギャップ360度を返す。
function computeAzimuthalGapDeg(centerLat, centerLon, detections) {
  if (detections.length < 2) return 360;
  const bearings = detections
    .map(d => bearingDeg(centerLat, centerLon, d.lat, d.lon))
    .sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 0; i < bearings.length; i++) {
    const gap = i === bearings.length - 1
      ? 360 - bearings[i] + bearings[0]
      : bearings[i + 1] - bearings[i];
    if (gap > maxGap) maxGap = gap;
  }
  return maxGap;
}

// 【23節】方位角ギャップ(度)から、震度較正ペナルティに掛ける倍率を求める。
// GAP_PENALTY_THRESHOLD_DEG(180度)以下は1倍(補正なし)、そこから360度に
// 向かって線形にAMPLITUDE_GAP_MAX_MULTIPLIERまで強める。
function amplitudePenaltyMultiplierForGap(gapDeg) {
  if (gapDeg <= GAP_PENALTY_THRESHOLD_DEG) return 1;
  const t = (gapDeg - GAP_PENALTY_THRESHOLD_DEG) / (360 - GAP_PENALTY_THRESHOLD_DEG); // 0〜1
  return 1 + t * (AMPLITUDE_GAP_MAX_MULTIPLIER - 1);
}

// 【B】方位角ギャップ(度)から、S-P時間差ペナルティに掛ける倍率を求める。
// 考え方はamplitudePenaltyMultiplierForGapと同じだが、上限がSP_TIME_GAP_
// MAX_MULTIPLIER(控えめな2倍)になっている。
function spTimePenaltyMultiplierForGap(gapDeg) {
  if (gapDeg <= GAP_PENALTY_THRESHOLD_DEG) return 1;
  const t = (gapDeg - GAP_PENALTY_THRESHOLD_DEG) / (360 - GAP_PENALTY_THRESHOLD_DEG); // 0〜1
  return 1 + t * (SP_TIME_GAP_MAX_MULTIPLIER - 1);
}

// 【A】ある方位(bearingDeg)における、許容する探索半径(度)を求める。
// outwardBearingDegがnull(観測点マスタが無い、または内部点)の場合は常に
// 通常のGRID_SEARCH_RADIUS_DEGを返す(=非対称拡張なし)。outwardBearingDeg
// との角度差が小さいほど(その方向に近いほど)EXTENDED_GRID_SEARCH_RADIUS_DEG
// に近づき、90度以上離れると通常の範囲に戻る、cos²カーブでなだらかに補間する。
function allowedGridRadiusDeg(bearingDeg, outwardBearingDeg) {
  if (outwardBearingDeg == null) return GRID_SEARCH_RADIUS_DEG;
  const diffDeg = Math.abs(((bearingDeg - outwardBearingDeg + 540) % 360) - 180);
  if (diffDeg >= 90) return GRID_SEARCH_RADIUS_DEG;
  const cosFactor = Math.cos(diffDeg * Math.PI / 180);
  return GRID_SEARCH_RADIUS_DEG + (EXTENDED_GRID_SEARCH_RADIUS_DEG - GRID_SEARCH_RADIUS_DEG) * cosFactor * cosFactor;
}

// shakeTestSimulation.tsのtravelTimeMsと同じ考え方(震源距離÷速度)。
// P波/S波の判別はせず、常にP波速度モデルを使う(記事同様の簡略化)。
function travelTimeMs(distKm, depthKm) {
  const distHypo = Math.sqrt(distKm * distKm + depthKm * depthKm);
  return (distHypo / P_WAVE_SPEED_KM_S) * 1000;
}

// 到達時刻の分散・震度較正ペナルティ・重み付き発生時刻の共通の重み関数。
//
// 【なぜ反比例(1/distKm)ではなく二乗(1/distKm²)にしたか】
// 実運用で報告された不具合(秋田県沖M5.8のシミュレーションで、検知点数が
// 112点に増えた時点で、推定震源が実際の震源よりさらに西の沖合(誤差約
// 181km)・深さが上限の150km(誤差+130km)に張り付く)を調査した結果、
// 反比例の重みでは減衰が緩すぎ、震源から遠い(＝個々の情報量は乏しい)
// 弱い揺れの観測点が数十〜100点規模で大量に加わると、重みの合計が近傍の
// 少数の高震度観測点(震源位置の主な手がかり)を上回ってしまい、震源が
// 観測点の「量」に引きずられる(震度較正ペナルティ側でも、遠方の弱い
// 観測点が多いほど、より深い震源+より大きいマグニチュードの組み合わせで
// 「そこそこ説明がついてしまう」退化的な解に流れやすくなる)ことを確認した。
// 二乗にすることで、震源距離が2倍の観測点の影響力を4分の1に(反比例の
// 半分)に抑え、近傍観測点の相対的な発言力を確保する。
//
// 【21節・22節: 呼び出し側の距離基準の修正】
// この関数自体は変わっていないが、21節で「呼び出し側が渡すdistKmが、
// 候補ごとに動く候補震源からの距離になっていた」という重大な不具合が
// 判明した。候補を観測点群から遠ざけるほど、全観測点の重みが一斉に
// ゼロへ近づき、フィットの良し悪しに関係なく誤差レベル全体が下がって
// しまう(＝探索範囲の外縁に向かうほど有利な、人工的な「谷」ができて
// しまう)ため、観測点をどれだけ陸に配置しても震源が沖合や探索範囲の
// 端に飛んでいってしまう根本原因になっていた。22節で、重みの計算には
// 「観測点からグリッド中心(固定の基準点)までの距離」を使うよう修正し、
// 誤差項自体(到達時刻・震度のズレ)は引き続き候補ごとの距離を使うように
// 分離した。詳細はestimateEpicenter内のdetectionWeightByIdのコメント参照。
function weightForDistance(distKm, firstDistKm) {
  if (distKm <= NEAR_STATION_FIXED_WEIGHT_RADIUS_KM) return 1;
  const ratio = firstDistKm / Math.max(distKm, 0.001);
  return ratio * ratio;
}

// 震度(連続値intensity)を、相対的な重み付けに使えるPGV相当値に変換する。
// shakeTestSimulation.tsのcalcPeakIntensity(intensity = 2.68 + 1.72*log10(pgv))
// の逆関数で、絶対値としての精度は求めていない(観測点間の相対比較にのみ使う)。
// 震度が高い観測点ほど指数的に大きな重みになる。
// 【対策: マグニチュード推定が常に低い値に収束するバグ】以前はlevel(0〜4の
// 離散値、levelThresholds=[0.5,2.0,3.5,5.0]で丸めたもの)をそのままこの式に
// 入れていたが、calcPeakIntensityの連続値スケール(理論上7.5まで届く)と
// スケールが噛み合っておらず、強い地震でも「level=4」で頭打ちになって
// しまっていた。連続値のintensityを受け取るよう変更する。
function pgvWeightForIntensity(intensity) {
  return Math.pow(10, (intensity - 2.68) / 1.72);
}

// 【20節時点では未使用】グリッド中心を「最初に検知した観測点」に一本化した
// (20.2)ため、現在はestimateEpicenterから呼ばれていない。将来、方位角
// ギャップが小さい(観測点配置が良好な)場合だけ重心を使うハイブリッド案
// (20節の未決定事項)を試す際に再利用する可能性があるため、関数自体は
// 残してある。
//
// 検知済み観測点を震度(連続値intensity)で重み付けした重心を求める。震度が
// 高い(揺れが強い)観測点ほど震源に近いはず、という直感を仮震源の初期位置
// (グリッド中心)に反映させるためのもの。intensityを持たない観測点しか
// 無い場合はnullを返す(呼び出し側で最初に検知した観測点にフォールバック
// する)。
//
// 【なぜ全検知点ではなく上位数点だけを使うか】
// 当初は検知済み全点を使って重み付き重心を計算していたが、検知点数が
// 増えるにつれて震源から遠い(弱い)観測点が大量に加わり、個々の重みは
// 小さくても合計では無視できない影響力を持ってしまい、重心が観測網の
// 「多い側」(陸側)へ引きずられていく不具合を検証で確認した(150km沖の
// ケースで、検知点数12点では重心が真の震源から209km、487点まで増えると
// 277kmまでずれ、GRID_SEARCH_RADIUS_DEG(2度、概ね200km強)の探索範囲から
// 真の震源が完全に外れてしまっていた)。震度が高い(＝震源に近いと考えられる)
// 上位CENTROID_TOP_K点だけに絞ることで、大量の弱い遠方観測点による希釈・
// 偏りを防ぐ。
function computeAmplitudeWeightedCentroid(detections) {
  const withIntensity = detections.filter(d => d.intensity != null);
  if (withIntensity.length === 0) return null;
  const top = [...withIntensity].sort((a, b) => b.intensity - a.intensity).slice(0, CENTROID_TOP_K);

  let sumLat = 0, sumLon = 0, sumWeight = 0;
  for (const d of top) {
    const w = pgvWeightForIntensity(d.intensity);
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
// マグニチュードを粗く探索した上で、その残差(二乗誤差の重み付き合計)を
// ペナルティにする。単純な「震度と距離の順序が合っているか」の相関ではなく、
// 実際の減衰カーブ(非弾性減衰項を含む、距離が伸びるほど加速する非線形
// カーブ)を使うことで、観測点が一方向(陸側)に偏っている沖合の地震でも、
// 候補を沖へ動かしすぎると(実際の震度パターンに対して)説明が悪くなるように
// し、震源までの絶対距離にも制約がかかるようにしている。
//
// 到達時刻の分散(computeErrorLevel内)と同じ重みを使い、遠い観測点ほど
// 重みを小さくする。これが無いと、実際の地震で揺れが広がるにつれて
// 遠方の(震源に近い観測点に比べて相対的にノイズが乗りやすい)観測点が
// どんどん検知に加わっていったとき、それらが近傍の高震度観測点と対等な
// 重みで残差に加算されてしまい、検知点数が増えるほど震源に近い・情報量の
// 多い観測点の影響力が相対的に薄れて位置が不安定になる/収束しない不具合が
// あった(実運用での報告により発覚、修正済み)。
// 観測点数が少ない場合はフィットが不安定なため計算をスキップする(0を返す)。
//
// detectionWeightByIdは、観測点id→重み(候補に依存しない固定値)のMap。
// 21節で判明した不具合(重みの計算に候補震源からの距離を使っていたため、
// 候補を遠ざけるほど全観測点の重みが一斉にゼロへ近づき、フィット精度に
// 関係なく誤差が下がってしまう)の修正のため、22節でfirstDistKmの代わりに
// この固定の重みMapを受け取るようにした。
// 候補震源(位置・深さ)と各観測点の震度パターンに、最もよく合う
// マグニチュードを探索する共通ロジック。computeAmplitudeCalibrationPenalty
// (探索中に何度も呼ばれる、誤差レベル計算用)と、estimateEpicenter終端の
// 推定マグニチュード算出(最終候補について1回だけ呼ばれる、ユーザー表示用)
// の両方から使う。
//
// 【対策: マグニチュード推定が、どんな地震でもだいたい3前半に収束する
// バグ】以前は観測データとしてlevel(0〜4の離散値、levelThresholds=
// [0.5,2.0,3.5,5.0]で丸めたもの)を使っており、calcPeakIntensityが返す
// 連続値のスケール(理論上7.5まで届く)と直接比較していた。震源直上で
// 震度6〜7に達するような強い地震でも観測側は「level=4」で頭打ちになる
// ため、フィットがその情報を活かせず、どんな地震でも同じような(弱め の)
// マグニチュードに収束していた。連続値のintensityを使うよう変更した。
// intensityが無い(古いデータ等)観測点は、フォールバックとしてlevelを
// 使う(この場合は上記の頭打ち制約が残る)。
function fitMagnitude(candidate, detections, detectionWeightById, magnitudeCandidates) {
  const withObserved = detections
    .map(d => ({ d, observed: d.intensity != null ? d.intensity : d.level }))
    .filter(x => x.observed != null);
  if (withObserved.length < MIN_POINTS_FOR_AMPLITUDE_CHECK) return null;

  const distHypoByStation = [];
  const weightByStation = [];
  for (const { d } of withObserved) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    distHypoByStation.push(Math.sqrt(distKm * distKm + candidate.depthKm * candidate.depthKm));
    weightByStation.push(detectionWeightById.get(d.id) ?? 0);
  }

  let bestMagnitude = magnitudeCandidates[0];
  let bestSumSq = Infinity;
  for (const m of magnitudeCandidates) {
    let sumSq = 0;
    for (let i = 0; i < withObserved.length; i++) {
      const predicted = calcPeakIntensity(m, candidate.depthKm, distHypoByStation[i]);
      const diff = predicted - withObserved[i].observed;
      sumSq += weightByStation[i] * diff * diff;
    }
    if (sumSq < bestSumSq) { bestSumSq = sumSq; bestMagnitude = m; }
  }

  return { magnitude: bestMagnitude, sumSq: bestSumSq };
}

// penaltyMultiplier: 【23節】観測点配置の片側偏り(方位角ギャップ)に応じて
// 呼び出し側(estimateEpicenter)が計算する倍率。省略時(1)は従来通り。
function computeAmplitudeCalibrationPenalty(candidate, detections, detectionWeightById, penaltyMultiplier = 1) {
  if (detections.length < MIN_POINTS_FOR_AMPLITUDE_CHECK) return 0;
  const fit = fitMagnitude(candidate, detections, detectionWeightById, CALIBRATION_MAGNITUDE_CANDIDATES);
  if (!fit) return 0;
  return AMPLITUDE_PENALTY_WEIGHT * penaltyMultiplier * fit.sumSq;
}

// 検知済み観測点群から、重み付き平均発生時刻を計算する。
// detectionWeightByIdは観測点id→固定の重みのMap(詳細は
// computeAmplitudeCalibrationPenaltyのコメント参照)。
function computeWeightedOriginTime(candidate, detections, detectionWeightById) {
  let weightedSum = 0;
  let weightSum = 0;
  for (const d of detections) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    const tt = travelTimeMs(distKm, candidate.depthKm);
    const originTime = d.detectedAt - tt;
    const weight = detectionWeightById.get(d.id) ?? 0;
    weightedSum += originTime * weight;
    weightSum += weight;
  }
  return weightSum > 0 ? weightedSum / weightSum : null;
}

// detectionsのうち、anchorLat/anchorLonに近い順にMAX_STATIONS_FOR_ESTIMATION
// 点だけを選ぶ(検知点数が増えても計算コストが頭打ちになるようにするため。
// 詳細はMAX_STATIONS_FOR_ESTIMATIONのコメント参照)。anchor(最初に検知した
// 観測点)は、発生時刻・重み計算の基準として使われているため、選ばれなかった
// 場合でも必ず含める。
function selectNearestDetections(detections, anchorLat, anchorLon, anchor) {
  if (detections.length <= MAX_STATIONS_FOR_ESTIMATION) return detections;
  const withDist = detections.map(d => ({ d, dist: haversineKm(anchorLat, anchorLon, d.lat, d.lon) }));
  withDist.sort((a, b) => a.dist - b.dist);
  const selected = withDist.slice(0, MAX_STATIONS_FOR_ESTIMATION).map(x => x.d);
  if (!selected.includes(anchor)) selected.push(anchor);
  return selected;
}

/**
 * 候補震源の誤差レベルを、到達時刻の重み付き分散と震度較正ペナルティ
 * (揺れの広がり方)で計算する中コスト版。粗いグリッド探索(coarseステージ)
 * 専用。
 *
 * 【なぜ到達時刻の分散だけでは不十分か】
 * 当初は粗い探索を到達時刻の分散のみ(震度較正を省いた軽量版)で行っていたが、
 * これは11節で修正したはずの「観測点が陸側に偏る沖合の地震で、震源が
 * 実際より遠くの沖合まで推定される」問題を粗い探索の段階で再発させてしまい、
 * 検知点数が増えるにつれて推定誤差が時間とともに単調に拡大する不具合(検証で
 * 最大57km、150km沖のケース)を引き起こすことを確認した。震度較正ペナルティ
 * (揺れの広がり方の手がかり)が無いと、到達時刻だけでは観測網が片側に偏る
 * 状況での絶対距離を十分に制約できないため、粗い探索の段階から震度較正は
 * 含める必要がある。
 * 一方、着未着法(未検知観測点のループ)は候補ごとにO(未検知観測点数)の
 * コストがかかり、かつ粗い探索の目的(有望な領域への絞り込み)には必須では
 * ないため、これだけは省略して速度を確保している(最終的な精緻な判定は
 * 着未着法も含むフルコスト版computeErrorLevelで行う)。
 *
 * 【片側偏り(海側等に観測点が無い)への対処について】
 * 以前はここでgridCenterからの距離に応じたソフトな正則化ペナルティを
 * 加算し、20節ではさらに空白方位側の候補を除外するハードな制約に変更
 * したが、その後の指示によりこの対処自体をいったん撤去した。23節で、
 * 候補の位置自体を操作する形ではなく、震度較正ペナルティの重み
 * (amplitudePenaltyMultiplier引数)を片側偏りの度合いに応じて動的に
 * 強める形で再導入している。詳細はファイル冒頭の23節コメント参照。
 *
 * 【22節: 重みの基準を候補震源からグリッド中心に変更】
 * 21節で判明した不具合(重みの計算に候補震源からの距離を使っていたため、
 * 候補を遠ざけるほど全観測点の重みが一斉にゼロへ近づき、フィット精度に
 * 関係なく誤差レベルが下がってしまう=観測点をどれだけ陸に配置しても
 * 震源が探索範囲の外縁に飛んでいってしまう根本原因)を修正するため、
 * firstDistKmの代わりに、観測点id→固定の重みのMap(detectionWeightById、
 * estimateEpicenter内でグリッド中心を基準に1回だけ計算)を受け取るように
 * 変更した。
 */
function computeCoarseErrorLevel(candidate, detections, detectionWeightById, amplitudePenaltyMultiplier = 1, spTimePenaltyMultiplier = 1) {
  const meanOriginTime = computeWeightedOriginTime(candidate, detections, detectionWeightById);
  if (meanOriginTime == null) return Infinity;

  let errorLevel = 0;
  for (const d of detections) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    const tt = travelTimeMs(distKm, candidate.depthKm);
    const originTime = d.detectedAt - tt;
    const weight = detectionWeightById.get(d.id) ?? 0;
    const diff = originTime - meanOriginTime;
    errorLevel += weight * diff * diff;
    // 【C: 早着(理論上あり得ない検知)への追加ペナルティ】diffが負ということは、
    // この観測点が示唆する発生時刻が全体平均より早い=候補の想定(全体平均の
    // 発生時刻からの走時)では「まだP波が届いていないはず」の段階で、実際には
    // もう検知している、という物理的に矛盾した状態を意味する。検知が予測より
    // 遅いこと(通常運用でも普通に起こる)とは非対称に扱うため、この場合だけ
    // 同じ重み・同じ二乗の値をもう一度加算する(＝実質2倍の重みになる)。
    // 到達時刻分散と全く同じ単位・オーダーで計算しているため、特別な倍率
    // 定数は設けていない。着未着法(未検知観測点向け)の、検知済み観測点版に
    // あたる。coarse・fine両方の段階から常時有効にしている。
    if (diff < 0) errorLevel += weight * diff * diff;
  }
  errorLevel += computeAmplitudeCalibrationPenalty(candidate, detections, detectionWeightById, amplitudePenaltyMultiplier);
  // 【対策: 深さの推定誤差がとても大きい問題】S-P時間差ペナルティも、
  // 震度較正ペナルティと同じ理由(粗い探索の段階で既に深さ候補の絞り込みに
  // 効かせないと、fineステージのoffsets探索範囲(±20km)では取り返せない)
  // で、粗い探索の段階から含める。着未着法とは異なり、追加コストは観測点
  // 数に比例するだけの軽い計算のため、速度への影響も小さい。
  errorLevel += computeSpTimePenalty(candidate, detections, detectionWeightById, spTimePenaltyMultiplier);
  return errorLevel;
}

// 【対策: 深さの推定誤差がとても大きい問題】S-P時間差(初期微動継続時間)
// による深さ推定の補強。観測点ごとに、S波相当(sWaveDetectedAt)とP波相当
// (detectedAt)の到達時刻差(実測)と、候補震源の震源距離から求まる理論上の
// S-P時間差との残差を二乗して重み付き加算する。震度(振幅)とは独立した
// 手がかりのため、深さ-マグニチュードのトレードオフに引っ張られにくい。
// penaltyMultiplier: 【B】観測点配置の片側偏り(方位角ギャップ)に応じて
// 呼び出し側(estimateEpicenter)が計算する倍率。省略時(1)は従来通り。
function computeSpTimePenalty(candidate, detections, detectionWeightById, penaltyMultiplier = 1) {
  let penalty = 0;
  let count = 0;
  for (const d of detections) {
    if (d.sWaveDetectedAt == null) continue;
    const observedSpSec = (d.sWaveDetectedAt - d.detectedAt) / 1000;
    if (observedSpSec < 0) continue; // 理論上あり得ない(データ不整合)ため除外
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    const distHypoKm = Math.sqrt(distKm * distKm + candidate.depthKm * candidate.depthKm);
    const expectedSpSec = distHypoKm * (1 / S_WAVE_SPEED_KM_S - 1 / P_WAVE_SPEED_KM_S);
    const diffMs = (observedSpSec - expectedSpSec) * 1000;
    const weight = detectionWeightById.get(d.id) ?? 0;
    penalty += weight * diffMs * diffMs;
    count++;
  }
  if (count < MIN_POINTS_FOR_SP_TIME_CHECK) return 0;
  return penalty * SP_TIME_PENALTY_WEIGHT * penaltyMultiplier;
}

/**
 * 候補震源の誤差レベルを計算する(小さいほど実際の震源に近い)。
 * 到達時刻の分散に加え、震度較正ペナルティ・着未着法も含むフルコスト版。
 * 細かいグリッド探索(fineステージ)・一意性チェック専用。
 * detections: [{id, lat, lon, detectedAt}] (最初に検知した観測点を含む)
 * nearbyUndetectedStations: 着未着法用の、あらかじめ絞り込み済みの未検知
 * 観測点候補([{id,lat,lon}, ...])。nullなら着未着法をスキップ。
 * detectionWeightByIdはcomputeCoarseErrorLevelと同じ(22節、固定の重みMap)。
 * amplitudePenaltyMultiplierもcomputeCoarseErrorLevelと同じ(23節、片側
 * 偏りの度合いに応じた震度較正ペナルティの倍率)。spTimePenaltyMultiplierは
 * 同じ考え方のS-P時間差ペナルティ版(B、SP_TIME_GAP_MAX_MULTIPLIER上限)。
 */
function computeErrorLevel(candidate, detections, detectionWeightById, nearbyUndetectedStations, now, amplitudePenaltyMultiplier = 1, spTimePenaltyMultiplier = 1) {
  const meanOriginTime = computeWeightedOriginTime(candidate, detections, detectionWeightById);
  if (meanOriginTime == null) return Infinity;

  let errorLevel = 0;
  for (const d of detections) {
    const distKm = haversineKm(candidate.lat, candidate.lon, d.lat, d.lon);
    const tt = travelTimeMs(distKm, candidate.depthKm);
    const originTime = d.detectedAt - tt;
    const weight = detectionWeightById.get(d.id) ?? 0;
    const diff = originTime - meanOriginTime;
    errorLevel += weight * diff * diff;
    // 【C】coarse版(computeCoarseErrorLevel)と同じ、早着(理論上あり得ない
    // 検知)への追加ペナルティ。詳細はそちらのコメント参照。
    if (diff < 0) errorLevel += weight * diff * diff;
  }

  // 揺れの広がり方(震度の減衰パターン)による整合性ペナルティ。到達時刻の
  // 分散だけでは区別しにくい候補同士(特に、観測点が一方向に偏っていて
  // 絶対距離が決まりにくい沖合の地震)を、震度パターンの物理的な説明の
  // 良さで追加的に絞り込む(詳細はcomputeAmplitudeCalibrationPenalty参照)。
  errorLevel += computeAmplitudeCalibrationPenalty(candidate, detections, detectionWeightById, amplitudePenaltyMultiplier);

  // 【対策: 深さの推定誤差がとても大きい問題】S-P時間差による深さの
  // 直接的な制約を追加する(詳細はcomputeSpTimePenalty参照)。
  errorLevel += computeSpTimePenalty(candidate, detections, detectionWeightById, spTimePenaltyMultiplier);

  // 着未着法(堀内ほか, 2007の式(1)を参考): 検知初期(3秒以内、または検知
  // 点数が30点未満)のみ、未検知観測点への制約を加える。未検知観測点iに
  // ついて、理論到達時刻Tiと現在時刻Tnowの間にはTnow−Ti＜0が成立するはず
  // (＝まだ届いていないなら、理論到達時刻は現在時刻より後のはず)。これが
  // 破れる場合(Tnow≥Ti、＝もう届いているはずなのに未検知)の残差
  // εi=Tnow−Tiを2乗し、そのままerrorLevelに加算する(単位は到達時刻の
  // 分散と同じms²なので、特別な重み係数は不要)。
  if (nearbyUndetectedStations) {
    const firstDetectedAt = Math.min(...detections.map(d => d.detectedAt));
    const elapsedSinceFirst = now - firstDetectedAt;
    if (elapsedSinceFirst <= UNDETECTED_CHECK_MAX_ELAPSED_MS || detections.length < UNDETECTED_CHECK_MAX_POINTS) {
      const detectedIds = new Set(detections.map(d => d.id));
      for (const s of nearbyUndetectedStations) {
        if (detectedIds.has(s.id)) continue;
        const distKm = haversineKm(candidate.lat, candidate.lon, s.lat, s.lon);
        const tt = travelTimeMs(distKm, candidate.depthKm);
        const arrivalTime = meanOriginTime + tt;
        const epsilon = now - arrivalTime; // > 0 なら「届いているはずなのに未検知」の違反
        if (epsilon > 0) errorLevel += epsilon * epsilon;
      }
    }
  }

  return errorLevel;
}

/**
 * イベントから震源を推定する(1回分の計算を行う純粋関数)。
 *
 * event: shakeDetection.tsのprocessTick()が返すイベント(detectionsフィールドを持つもの)。
 * allStations: 着未着法・23節の片側偏り補正(テリトリー法ベースの観測点分類)
 * 用の全観測点マスタ([{id,lat,lon}, ...])。省略時はどちらもスキップする。
 * now: 現在時刻(ms)。省略時はDate.now()。
 *
 * 戻り値: { lat, lon, depthKm, originTime, errorLevel, pointCount, uniquenessConfirmed } | null
 * (検知点数がMIN_DETECTION_POINTS未満の場合はnull=推定不能)。
 * confirmed(収束したかどうか)はこの関数自体は状態を持たないため付与しない。
 * EpicenterEstimator.updateAll()を経由した結果にのみconfirmed/stableForMsが
 * 追加される。
 */
export function estimateEpicenter(event, allStations = null, now = Date.now()) {
  const detections = event?.detections;
  if (!detections || detections.length < MIN_DETECTION_POINTS) return null;

  // 最初に検知した観測点(発生時刻の基準・重み計算の基準距離に使う)。
  let first = detections[0];
  for (const d of detections) {
    if (d.detectedAt < first.detectedAt) first = d;
  }

  // 【20節: グリッド中心を「震度重み付き重心」から「最初に検知した観測点」に
  //   変更】
  // 以前は震度で重み付けした重心(computeAmplitudeWeightedCentroid)を
  // グリッド中心にしていた。これは複数点の情報を使える利点がある一方、
  // 「内陸に震源を置いても、検知点が片側(陸側)に偏っていると推定が海側に
  // ズレる」という退行が実運用で確認された。原因の一つとして、重心自体が
  // (検知した陸上の観測点だけで計算されるため)真の震源より系統的にズレた
  // 位置に来てしまい、それを基準に探索するとズレを引きずってしまうことが
  // 疑われる。気象庁のグリッドサーチ法は「最初に揺れた観測点」を中心に
  // 2度以内を探索する、と明記されており、単一観測点は複数点の平均に比べて
  // 系統的な偏りを持ちにくい。これに合わせ、常に最初に検知した観測点を
  // グリッド中心にする。
  const gridCenterLat = Math.round(first.lat * 100) / 100;
  const gridCenterLon = Math.round(first.lon * 100) / 100;

  // firstDistKmの再定義: 以前は「グリッド中心(重心)から最初の観測点までの
  // 距離」だったが、グリッド中心=最初の観測点にしたため、この定義では常に
  // 0になり重み関数(weightForDistance)が破綻する。代わりに「最初の観測点
  // から見て空間的に最も近い、他の検知観測点までの距離」を使う。これは
  // 観測点の局所的な密度を表す、同程度の意味を持つ基準距離になる。
  let firstDistKm = null;
  for (const d of detections) {
    if (d === first) continue;
    const dist = haversineKm(gridCenterLat, gridCenterLon, d.lat, d.lon);
    if (firstDistKm == null || dist < firstDistKm) firstDistKm = dist;
  }
  if (firstDistKm == null || firstDistKm <= 0) firstDistKm = NEAR_STATION_FIXED_WEIGHT_RADIUS_KM;

  // 【A・B共通の静的ゲート】最初の観測点(グリッド中心)が観測点マスタ全体の
  // 中で「内部点」(=構造的に観測網に囲まれている)かどうかを、探索前に
  // 1回だけ判定しておく。内部点ならA(探索範囲の非対称拡張)・B(S-P時間差
  // ペナルティの動的強化)・23節(震度較正ペナルティの動的強化)のいずれも
  // 発動しない(=既存の挙動のまま)。allStationsが渡されない場合も同様。
  // 23節と同じ理由(検知点数が少ない早い段階でたまたま片側にしか検知が
  // 無いだけの内陸イベントまで過剰に反応するのを防ぐ)で、この判定は
  // 「観測点マスタ全体における構造的な位置」という、今回の検知パターンに
  // 左右されない安定した基準にしている。
  let outwardBearingDeg = null;
  if (allStations) {
    const territories = getStationTerritories(allStations);
    const anchorTerritory = territories.get(first.id);
    if (anchorTerritory && anchorTerritory.type !== "interior") {
      outwardBearingDeg = anchorTerritory.outwardBearingDeg;
    }
  }

  // 誤差レベル計算に使う検知点・未検知観測点候補は、グリッド中心を基準に
  // 1回だけ絞り込む(探索範囲がGRID_SEARCH_RADIUS_DEG以内に構造的に限定
  // されているため、これで探索範囲全体をカバーできる。詳細は定数コメント
  // 参照)。【A】非対称拡張が発動する場合は、探索範囲自体が最大
  // EXTENDED_GRID_SEARCH_RADIUS_DEGまで広がるため、この絞り込み・
  // 未検知観測点の事前フィルタ半径もその分だけ広げておかないと、拡張された
  // 領域の候補が本来考慮すべき観測点データを取りこぼしてしまう。
  const effectiveSearchRadiusDeg = outwardBearingDeg != null ? EXTENDED_GRID_SEARCH_RADIUS_DEG : GRID_SEARCH_RADIUS_DEG;
  const estimationDetections = selectNearestDetections(detections, gridCenterLat, gridCenterLon, first);
  let nearbyUndetectedStations = null;
  if (allStations) {
    const extraRadiusKm = (effectiveSearchRadiusDeg - GRID_SEARCH_RADIUS_DEG) * 111; // 緯度1度≒111km換算
    const detectedIdsFull = new Set(detections.map(d => d.id));
    nearbyUndetectedStations = allStations.filter(s =>
      !detectedIdsFull.has(s.id) &&
      haversineKm(gridCenterLat, gridCenterLon, s.lat, s.lon) <= UNDETECTED_STATION_PREFILTER_RADIUS_KM + extraRadiusKm
    );
  }

  // 【21節・22節】観測点ごとの重みを、グリッド中心(固定の基準点)からの
  // 距離を使って1回だけ計算しておく。以前はcomputeErrorLevel等の内部で
  // 「今評価している候補震源」からの距離を使って毎回計算していたが、これは
  // 候補を観測点群から遠ざけるほど全観測点の重みが一斉にゼロへ近づき、
  // フィット精度に関係なく誤差レベルが下がってしまう(探索範囲の外縁に
  // 向かうほど有利な、人工的な「谷」ができてしまう)という重大な不具合の
  // 原因だった。観測点id→重みのMapとして固定してから探索に渡すことで、
  // 「重み」は純粋にその観測点の(震源候補に依存しない)信頼度だけを表す
  // ようにし、誤差項自体(到達時刻・震度のズレ)だけが候補ごとに変わるように
  // 分離した。
  const detectionWeightById = new Map(
    estimationDetections.map(d => [d.id, weightForDistance(haversineKm(gridCenterLat, gridCenterLon, d.lat, d.lon), firstDistKm)])
  );

  const evalCoarse = (lat, lon, depthKm) =>
    computeCoarseErrorLevel({ lat, lon, depthKm }, estimationDetections, detectionWeightById);

  // 【24節】検知点数が少ない間だけ、coarse探索の評価候補を全て記録しておく
  // (マルチスタート用)。検知点数が多い場合はメモリ・比較コストが無駄になる
  // ため記録しない(coarseBest1点だけを追跡する、従来通りの軽量な経路)。
  const useMultistart = detections.length < MULTISTART_MAX_POINTS;

  // --- 粗い探索: グリッド中心を中心にCOARSE_GRID_STEP_DEG刻みで全数探索 ---
  // 候補数が多いため、軽量版(到達時刻の分散のみ)で評価する。この段階では
  // 23節・Bの片側偏り補正(震度較正・S-P時間差ペナルティの動的強化)は
  // まだ適用しない(理由は後述のコメント参照)。
  // 【A】outwardBearingDegが分かっている場合、その方向だけ探索範囲を
  // EXTENDED_GRID_SEARCH_RADIUS_DEGまで広げる(allowedGridRadiusDeg参照)。
  // ループ自体はeffectiveSearchRadiusDeg(拡張時のみ広い方)を上限に回すが、
  // 各セルの採否はそのセルの方位ごとの許容半径で判定するため、拡張しない
  // 方位のセルは従来通りGRID_SEARCH_RADIUS_DEGで打ち切られる(=通常の
  // イベントでの実質的な評価候補数は変わらない)。
  const coarseDepths = buildDepthCandidates(detections.length, "coarse", null);
  let coarseBest = { lat: gridCenterLat, lon: gridCenterLon, depthKm: coarseDepths[0], error: Infinity };
  const coarseEvaluated = useMultistart ? [] : null;
  for (let dLat = -effectiveSearchRadiusDeg; dLat <= effectiveSearchRadiusDeg + 1e-9; dLat += COARSE_GRID_STEP_DEG) {
    for (let dLon = -effectiveSearchRadiusDeg; dLon <= effectiveSearchRadiusDeg + 1e-9; dLon += COARSE_GRID_STEP_DEG) {
      const offsetDeg = Math.sqrt(dLat * dLat + dLon * dLon);
      if (outwardBearingDeg != null) {
        const cellBearing = bearingDeg(gridCenterLat, gridCenterLon, gridCenterLat + dLat, gridCenterLon + dLon);
        if (offsetDeg > allowedGridRadiusDeg(cellBearing, outwardBearingDeg)) continue;
      } else if (offsetDeg > GRID_SEARCH_RADIUS_DEG) {
        continue;
      }
      const lat = gridCenterLat + dLat;
      const lon = gridCenterLon + dLon;
      for (const depthKm of coarseDepths) {
        const error = evalCoarse(lat, lon, depthKm);
        if (coarseEvaluated) coarseEvaluated.push({ lat, lon, depthKm, error });
        if (error < coarseBest.error) coarseBest = { lat, lon, depthKm, error };
      }
    }
  }

  // 【24節】coarseの評価候補から、互いに十分離れた(=同じ谷の中の点を
  // 重複して数えない)局所解を、誤差の小さい順に貪欲法で最大
  // MULTISTART_MAX_CANDIDATES個選ぶ。「別の局所解」とみなす条件は、
  // 一意性チェックと同じ考え方(水平距離UNIQUENESS_MIN_DISTANCE_KM以上、
  // または深さの差UNIQUENESS_MIN_DEPTH_DIFF_KM以上)をそのまま流用する。
  // useMultistartがfalseの場合はcoarseBest1点だけを使う(従来通り)。
  let coarseStarts = [coarseBest];
  if (useMultistart && coarseEvaluated) {
    const sorted = [...coarseEvaluated].sort((a, b) => a.error - b.error);
    coarseStarts = [];
    for (const c of sorted) {
      if (coarseStarts.length >= MULTISTART_MAX_CANDIDATES) break;
      const isDistinct = coarseStarts.every(s => {
        const horizontalFar = haversineKm(s.lat, s.lon, c.lat, c.lon) >= UNIQUENESS_MIN_DISTANCE_KM;
        const depthFar = Math.abs(s.depthKm - c.depthKm) >= UNIQUENESS_MIN_DEPTH_DIFF_KM;
        return horizontalFar || depthFar;
      });
      if (isDistinct) coarseStarts.push(c);
    }
    if (coarseStarts.length === 0) coarseStarts = [coarseBest];
  }

  // --- 細かい探索: coarseStartsの各点の周辺だけをFINE_GRID_STEP_DEG(0.1度)
  // 刻みで独立に探索し、フルコスト版(震度較正・S-P時間差・着未着法込み)で
  // 評価する。一意性チェック用に、評価した全候補(位置・誤差レベル)を
  // 記録しておく。マルチスタート時は、各開始点ごとに23節・Bの片側偏り補正
  // (方位角ギャップ)を個別に計算し直す(開始点によって観測点配置から見た
  // 片側偏りの状況が変わりうるため)。
  let fineBest = { lat: coarseBest.lat, lon: coarseBest.lon, depthKm: coarseBest.depthKm, error: Infinity };
  const fineEvaluated = [];
  for (const start of coarseStarts) {
    // 【23節・B】片側偏り補正: 震度較正・S-P時間差ペナルティの倍率を求める。
    // 静的なゲート(outwardBearingDegがnullでない=最初の観測点が観測点
    // マスタ全体の外部点/孤立点)は、探索開始前に1回だけ判定済み(A参照)の
    // ものをそのまま使う。ここでは、そのゲートを通過した場合のみ、開始点
    // (start、実際の到達時刻・震度にある程度反応済みの位置)を基準に方位角
    // ギャップを計算し、その大きさに応じた倍率を求める。ギャップの基準点に
    // グリッド中心(最初に検知した陸上観測点)を使うと、震源が海域にあっても
    // その周囲(内陸方向)には観測点が多方向にあるため方位角ギャップが小さく
    // 出てしまい、片側偏りを正しく検出できないことを実験的に確認している。
    let amplitudePenaltyMultiplier = 1;
    let spTimePenaltyMultiplier = 1;
    if (outwardBearingDeg != null) {
      const gapDeg = computeAzimuthalGapDeg(start.lat, start.lon, estimationDetections);
      amplitudePenaltyMultiplier = amplitudePenaltyMultiplierForGap(gapDeg);
      spTimePenaltyMultiplier = spTimePenaltyMultiplierForGap(gapDeg);
    }

    const evalFine = (lat, lon, depthKm) =>
      computeErrorLevel({ lat, lon, depthKm }, estimationDetections, detectionWeightById, nearbyUndetectedStations, now, amplitudePenaltyMultiplier, spTimePenaltyMultiplier);

    const fineDepths = buildDepthCandidates(detections.length, "fine", start.depthKm);
    for (let dLat = -FINE_GRID_RADIUS_DEG; dLat <= FINE_GRID_RADIUS_DEG + 1e-9; dLat += FINE_GRID_STEP_DEG) {
      for (let dLon = -FINE_GRID_RADIUS_DEG; dLon <= FINE_GRID_RADIUS_DEG + 1e-9; dLon += FINE_GRID_STEP_DEG) {
        const lat = start.lat + dLat;
        const lon = start.lon + dLon;
        for (const depthKm of fineDepths) {
          const error = evalFine(lat, lon, depthKm);
          fineEvaluated.push({ lat, lon, depthKm, error });
          if (error < fineBest.error) fineBest = { lat, lon, depthKm, error };
        }
      }
    }
  }

  const best = { lat: Math.round(fineBest.lat * 100) / 100, lon: Math.round(fineBest.lon * 100) / 100, depthKm: fineBest.depthKm };

  const originTime = computeWeightedOriginTime(best, estimationDetections, detectionWeightById)
    ?? (first.detectedAt - ORIGIN_TIME_FALLBACK_OFFSET_MS);

  // 解の一意性チェック(堀内ほか, 2007を参考)。細かいグリッド探索で既に
  // 評価済みの候補群から、最良解と十分離れた(UNIQUENESS_MIN_DISTANCE_KM
  // 以上)場所にほぼ同じくらい良い候補(誤差レベルがUNIQUENESS_RATIO_
  // THRESHOLD倍以内)が無いかを調べる。追加の評価コストはほぼゼロ。
  // 【対策: 深さの推定誤差がとても大きい問題】水平距離だけでなく、深さの
  // 差がUNIQUENESS_MIN_DEPTH_DIFF_KM以上ある候補も「別解」とみなす
  // (詳細はUNIQUENESS_MIN_DEPTH_DIFF_KMのコメント参照。緯度経度はほぼ
  // 同じで深さだけ大きく異なる、深さ-マグニチュードのトレードオフによる
  // 退化的な解を見逃さないようにするため)。
  let uniquenessConfirmed = true;
  const uniquenessThreshold = fineBest.error * UNIQUENESS_RATIO_THRESHOLD;
  for (const c of fineEvaluated) {
    if (c.error > uniquenessThreshold) continue;
    const horizontalFar = haversineKm(best.lat, best.lon, c.lat, c.lon) >= UNIQUENESS_MIN_DISTANCE_KM;
    const depthFar = Math.abs(best.depthKm - c.depthKm) >= UNIQUENESS_MIN_DEPTH_DIFF_KM;
    if (horizontalFar || depthFar) {
      uniquenessConfirmed = false;
      break;
    }
  }

  // 深さが探索上限に張り付いていないかのチェック(実運用で報告された不具合
  // ケースを踏まえた追加のガード)。深さの探索は本来、誤差レベルが最小になる
  // 「谷」で止まるはずであり、たまたま探索上限ちょうどが最良になるのは、
  // 谷が上限の外側(探索範囲外)にある退化的な解である可能性が高い
  // (震度の少ない・遠い観測点が大量にある場合、深さを大きくするほど
  // 誤差が下がり続けてしまう問題があった)。この場合は一意性チェックと
  // 同様にuniquenessConfirmedをfalseにし、収束扱いにしない。
  const maxDepthAllowed = maxDepthForPointCount(detections.length);
  if (maxDepthAllowed != null && best.depthKm >= maxDepthAllowed - 1e-6) {
    uniquenessConfirmed = false;
  }

  // 【推定マグニチュードの表示対応】最終的に選ばれた候補震源(best)について、
  // 探索中に使っていた粗い候補(CALIBRATION_MAGNITUDE_CANDIDATES)ではなく、
  // より細かい候補(FINAL_MAGNITUDE_CANDIDATES)でフィットし直す。1回しか
  // 呼ばないため、探索コストは気にしなくてよい。観測点数が少なすぎる
  // (MIN_POINTS_FOR_AMPLITUDE_CHECK未満)場合はnullになる。
  const magnitudeFit = fitMagnitude(best, estimationDetections, detectionWeightById, FINAL_MAGNITUDE_CANDIDATES);

  return {
    lat: best.lat,
    lon: best.lon,
    depthKm: best.depthKm,
    originTime,
    errorLevel: fineBest.error,
    pointCount: detections.length,
    uniquenessConfirmed,
    magnitude: magnitudeFit ? magnitudeFit.magnitude : null,
  };
}

/**
 * イベントごとに最後に推定した検知点数(pointCount)を覚えておき、点数が
 * 変化していなければ再計算せず前回の結果を使い回すキャッシュラッパー。
 * あわせて、推定位置がどれだけの時間安定しているかを追跡し、「検知点数が
 * 十分」「位置が動かなくなった(時間経過ベースの収束)」「周囲にほぼ同じ
 * くらい良い解が無い(一意性チェック、堀内ほか, 2007を参考)」の3条件を
 * 満たすかどうかを示すconfirmedフラグを結果に付与する(詳細は
 * CONVERGENCE_STABLE_MS・UNIQUENESS_*等のコメント参照)。
 * App.jsx側はshakeDetection.tsのprocessTick()の戻り値をそのままupdateAll()に
 * 渡すだけでよい(震央検出のON/OFFや再計算タイミングを個別に管理する必要はない)。
 */
export class EpicenterEstimator {
  constructor() {
    // stableDepthKm: 【対策: 深さの推定誤差がとても大きい問題】stablePos
    // (緯度経度)に加えて、深さも安定判定に含めるための記憶。
    this.cache = new Map(); // eventId -> { pointCount, result, stablePos, stableDepthKm, firstStableAt }
  }

  /**
   * events: shakeDetection.tsのprocessTick()の戻り値。
   * allStations: 着未着法・23節の片側偏り補正用の全観測点マスタ。
   * now: 現在時刻(ms)。収束判定(位置がどれだけ安定しているか)の基準に使うため、
   * 呼び出し側のtickの実時刻を渡すことを想定している。
   * 戻り値: Map<eventId, estimateEpicenter()の戻り値にconfirmedを追加したもの | null>
   */
  updateAll(events, allStations = null, now = Date.now()) {
    const activeIds = new Set();
    const results = new Map();

    for (const event of events) {
      activeIds.add(event.id);
      let entry = this.cache.get(event.id);

      let result;
      if (entry && entry.pointCount === event.pointCount) {
        result = entry.result;
      } else {
        result = estimateEpicenter(event, allStations, now);
        entry = {
          pointCount: event.pointCount,
          result,
          stablePos: entry?.stablePos ?? null,
          stableDepthKm: entry?.stableDepthKm ?? null,
          firstStableAt: entry?.firstStableAt ?? now,
        };
      }

      if (result) {
        // 【対策: 深さの推定誤差がとても大きい問題】以前は緯度経度
        // (stablePos)のみを見て安定判定していたため、緯度経度が安定して
        // いれば深さが毎tick大きく揺れ動いていてもconfirmed: trueになって
        // しまっていた。深さの変化もCONVERGENCE_DEPTH_TOLERANCE_KM以上
        // あれば「まだ動いている」とみなし、安定タイマーをリセットする。
        const positionMoved = !entry.stablePos
          || haversineKm(entry.stablePos.lat, entry.stablePos.lon, result.lat, result.lon) > CONVERGENCE_POSITION_TOLERANCE_KM;
        const depthMoved = entry.stableDepthKm == null
          || Math.abs(entry.stableDepthKm - result.depthKm) > CONVERGENCE_DEPTH_TOLERANCE_KM;
        if (positionMoved || depthMoved) {
          entry.stablePos = { lat: result.lat, lon: result.lon };
          entry.stableDepthKm = result.depthKm;
          entry.firstStableAt = now;
        }
        const stableForMs = now - entry.firstStableAt;
        const confirmed =
          stableForMs >= CONVERGENCE_STABLE_MS &&
          result.pointCount >= MIN_CONFIRMED_POINTS &&
          !!result.uniquenessConfirmed;
        result = { ...result, confirmed, stableForMs };
      }

      entry.result = result;
      this.cache.set(event.id, entry);
      results.set(event.id, result);
    }

    for (const id of this.cache.keys()) {
      if (!activeIds.has(id)) this.cache.delete(id);
    }

    return results;
  }
}
