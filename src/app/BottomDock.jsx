import { useContext, useRef, useState, useEffect, useLayoutEffect, useMemo, Fragment } from "react";
import { createPortal } from "react-dom";
import { EMPTY_EQDB_LIST, buildEqdbQuakeCard, fetchEqdbEventCached, fetchEqdbSearch, shouldShowNearbyQuakeButton } from "./eqdb";
import { ThemeContext, touchGlassBackdropFilter } from "./theme";
import { Glass, GlassOpaqueContext, PressableButton } from "./glass";
import { useIsWideLayout } from "./layoutHooks";
import { QUAKE_COLOR_SCHEMES, QuakeColorSchemeContext } from "./colorSchemes";
import { dedupeTsunamiList } from "./tsunamiData";
import { loadGeoData } from "./mapDataLoaders";
import { findCausingQuakeFromP2p } from "./quakeCards";
import { resolveStationPoints } from "./stations";
import { NearbyQuakesPanel, QuakeListRow, QuakeListToolbar, QuakeSearchPanel, TSUNAMI_TOOLBAR_ITEMS, defaultEqdbDateRange } from "./quakeSearchUi";
import { NAV_ICONS, useSnapDrag } from "./navUi";
import { NAV } from "./navigation";
import { BackToListButton, RealtimeDataTimeBadge, ShakeEventCard, ShakeTestRunningBadge, StationMarkerToggleButton } from "./mapOverlayUi";
import { EewDetailFloatingCard, EewFabButton } from "./eewUi";
import { PanelDragHandoffCard, QuakeDetailCard, QuakeMechDetailPanel, QuakeMessageCard, StationPointsList } from "./quakeDetailUi";
import { TsunamiTabBody } from "./tsunamiTideUi";
import { SettingsBody } from "./SettingsBody";


/* ─────────────────────────────────────────────────────
   BOTTOM DOCK
   ナビバーと地図レイヤーパネルを「ひとつの液体ガラス」として統合する。
   分割した2枚のGlassを並べるのではなく、単一のGlass表面の
   高さ・角丸だけを変化させることで、ナビバーのガラス素材そのものが
   下から上へ伸びて、内側からパネルが生まれてくるように見せる。

   - 高さ: useSnapDrag により、低(閉)・中・中高・中中高・高(従来の全開)・全画面の
     4段階のスナップ位置のどれかに固定される。先頭の白いハンドルを
     ドラッグすると、指の動きにリアルタイムで追従し、離した位置に
     最も近いスナップへ収まる。画面上部近くまで引き上げ続けると、
     そのまま画面いっぱいに広がる「全画面」状態まで連続的に伸びる。
   - 角丸: 高さの開き具合に応じて連続的に補間する。閉時は四隅とも
     ナビバー本来のピル(33px)、開くにつれて上だけ26pxへ柔らかく変化。
     999pxのような巨大な値は使わない(箱のサイズを超えてクランプされ、
     歪な円形になるのを防ぐため)。
   ───────────────────────────────────────────────────── */
export function BottomDock({
  active, onNav, navCollapseSignal, navDoubleTapSignal, layerOpen, layers, onToggleLayer, onLayerOpenChange,
  quakes, quakeStatus, selectedQuakeId, onSelectQuake, stationPoints = [],
  tsunamis = [], tsunamiStatus = "loading", selectedTsunamiId, onSelectTsunami,
  isViewingPastTsunami = false,
  tsunamiHistory, onLoadMoreTsunamiHistory, onCausingQuakeChange,
  onTsunamiViewModeChange,
  tideStations = EMPTY_EQDB_LIST, tideStationsStatus = "idle",
  selectedTideStationCode, onSelectTideStation, tideObsByStation = {}, onLoadTideObs,
  tideStationSelectSignal, tsunamiHeightByStation = {}, tsunamiHeightTimeByStation = {},
  stationMarkersVisible = true, onToggleStationMarkersVisible,
  tideStationMarkersVisible = true, onToggleTideStationMarkersVisible,
  onChangeQuakeColorScheme,
  estIntensityEnabled, onChangeEstIntensityEnabled,
  areaFillEnabled, onChangeAreaFillEnabled,
  faultsEnabled, onChangeFaultsEnabled,
  plateBoundariesEnabled, onChangePlateBoundariesEnabled,
  epicenterCirclesEnabled, onChangeEpicenterCirclesEnabled,
  boundaryLineColorId, onChangeBoundaryLineColorId,
  quakeFetchLimit, onChangeQuakeFetchLimit,
  stationListDisplayMode, onChangeStationListDisplayMode,
  experimentalFeaturesEnabled, onChangeExperimentalFeaturesEnabled,
  // realtimeApiToken, onChangeRealtimeApiToken, // 【廃止】APIトークン入力機能廃止に伴いコメントアウト
  replayPlayer,
  realtimeRisingEnabled, onChangeRealtimeRisingEnabled,
  replayJmaColorEnabled, onChangeReplayJmaColorEnabled,
  shakeDetectionEnabled, onChangeShakeDetectionEnabled,
  epicenterEstimationEnabled, onChangeEpicenterEstimationEnabled,
  shakeEvents = EMPTY_EQDB_LIST,
  realtimeDataTime,
  testTsunami, onBroadcastTestTsunami, onCancelTestTsunami, onClearTestTsunami,
  testEews = EMPTY_EQDB_LIST, onTestEewAction,
  eewTestForm, eewEpicenterPickActive,
  testQuake, onTestQuakeAction, quakeTestForm, quakeEpicenterPickActive, quakeTestAutoPlaying,
  shakeTests, onShakeTestAction, shakeTestForm, shakeTestEpicenterPickActive,
  epicenterEstimates,
  eews = EMPTY_EQDB_LIST, eewDetailOpen, eewOpenSignal, onOpenEewDetail, onCloseEewDetail,
  tsunamiAreaPickActive, onStartTsunamiAreaPick, pickedTsunamiAreas,
  onRemoveTsunamiAreaPick, onCycleTsunamiAreaGrade,
  pickedTsunamiHeights, onChangeTsunamiHeightPick, onRemoveTsunamiHeightPick,
  candidateHeightStations, onAddTsunamiHeightPick,
  stations, searchQuake, onFoundSearchQuake,
  onEpicenterPointsChange,
  onEpicenterLoadingChange,
  mapSelectSignal,
  uiScale = 1,
}) {
  const { tokens, mode } = useContext(ThemeContext);
  const { opaque: glassOpaque } = useContext(GlassOpaqueContext);

  const HANDLE_HEIGHT = 18; // ハンドル行の固定高さ(スクロールに巻き込まれず常に上部に固定)。
                            // 地震タブでは直下のQuakeListToolbarが縦ドラッグをこのハンドルへ
                            // 引き渡す(onHandoffToPanelDrag)ため、ハンドル自体を広げる必要はない。
  const isWide = useIsWideLayout(); // 横画面スマホ・タブレット・PCなどの広い画面かどうか
  const scrollRef = useRef(null);

  // 一覧⇄検索の切り替えや地震の選択/選択解除など、表示中身が切り替わって
  // scrollRef自体がkeyごと作り直される直前に呼ぶ。「勢いよくスクロールした
  // 直後に切り替える」と、iOSの慣性スクロール(フリック後の減速アニメーション)が
  // 古い要素に対してまだ動いている場合があり、key変更によるDOM要素の作り直しが
  // 1フレーム遅れるだけでも新しい要素側に慣性が乗り移って見えることがあるため、
  // 切り替えの直前にoverflowをhiddenにして慣性スクロールを即座に断ち切っておく
  // (新しい要素はstyle指定で改めてoverflow: autoになるので支障はない)。
  function killScrollMomentum() {
    // overflowをhidden→autoと切り替えて慣性スクロールを断ち切る方式は、
    // iOS Safariでボタン要素(地震一覧の各行など)がスクロールをまったく
    // 受け付けなくなる不具合の原因になっていたため廃止した。
    // スクロール位置の復元はuseLayoutEffect側でscrollTopを直接設定するだけで
    // 十分実用上問題なく、慣性も自然に収まる。
  }

  const colorSchemeId = useContext(QuakeColorSchemeContext);
  const colorScheme = QUAKE_COLOR_SCHEMES[colorSchemeId] || QUAKE_COLOR_SCHEMES.fill;

  // 設定タブ内の階層メニューの現在地。[] = トップメニュー、["quake"] = 地震カテゴリの
  // メニュー、["quake","colorScheme"] = 震度配色の中身、のようにパスで表現する。
  // 設定タブ以外に移動したら、次に開いた時は必ずトップメニューから始まるようにリセットする。
  const [settingsPath, setSettingsPath] = useState([]);
  useEffect(() => {
    if (active !== "settings") setSettingsPath([]);
  }, [active]);

  // 設定内の画面を切り替えるたびに、スクロール位置(共有の1本のscrollRef)を
  // 先頭へ戻す。そうしないと、例えば「利用規約」を下までスクロールした状態で
  // 「注意事項」に切り替えた時、同じスクロール位置が引き継がれてしまう。
  function handleSettingsNavigate(nextPath) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setSettingsPath(nextPath);
  }

  // 横画面(isWide)では、戻るボタンをガラスの外に浮かせて表示するため、
  // パネル本体(GlassOrPlainの中身)の画面上の位置を測っておく。
  const wideContentRef = useRef(null);
  const [wideAnchorRect, setWideAnchorRect] = useState(null);
  useLayoutEffect(() => {
    if (!isWide) { setWideAnchorRect(null); return; }
    const update = () => {
      if (wideContentRef.current) setWideAnchorRect(wideContentRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [isWide, active, selectedQuakeId, settingsPath]);

  // 地震タブの表示モード。"recent" = 直近の地震一覧(P2P地震情報フィード)、
  // "search" = 気象庁 震度データベースを検索するUI。
  // タブを離れたら次に開いた時は必ず「一覧」から始まるようにリセットする。
  // ただし、検索結果から地震を選択して詳細カードを表示している間に他のタブへ
  // 移動した場合はリセットしない。ここでリセットしてしまうと、タブを行き来して
  // 地震タブに戻ってきた時点では detail カードがそのまま表示され続けるため
  // 気づきにくいが、その後「戻る」を押した瞬間にquakeViewModeが既に"recent"に
  // 書き換わっており、本来戻るべき検索結果ではなく直近一覧に戻ってしまう
  // (=検索経由で選択→他タブ→戻る→「戻る」ボタンでリストタブになる不具合)。
  const [quakeViewMode, setQuakeViewMode] = useState("recent"); // "recent" | "search"
  useEffect(() => {
    if (active !== "quake" && selectedQuakeId == null) setQuakeViewMode("recent");
  }, [active, selectedQuakeId]);

  // 津波タブ版の表示モード。"recent" = 直近の津波情報一覧、
  // "history" = 過去に発表された津波情報一覧(/history APIをoffsetで遡って取得)。
  // 考え方はquakeViewModeと全く同じ(タブを離れたら「一覧」に戻す/選択中は維持)。
  const [tsunamiViewMode, setTsunamiViewMode] = useState("recent"); // "recent" | "history" | "tidegauge"
  useEffect(() => {
    if (active !== "tsunami" && selectedTsunamiId == null) setTsunamiViewMode("recent");
  }, [active, selectedTsunamiId]);

  // App側(地図の潮位計ピン表示用)に、現在のtsunamiViewModeを都度伝える。
  useEffect(() => {
    onTsunamiViewModeChange?.(tsunamiViewMode);
  }, [tsunamiViewMode, onTsunamiViewModeChange]);

  // 「過去」モードを初めて開いた時、まだ何も取得していなければ最初の1ページを取得する。
  useEffect(() => {
    if (
      active === "tsunami" && tsunamiViewMode === "history" &&
      tsunamiHistory && tsunamiHistory.items.length === 0 && tsunamiHistory.status === "idle"
    ) {
      onLoadMoreTsunamiHistory?.();
    }
  }, [active, tsunamiViewMode, tsunamiHistory, onLoadMoreTsunamiHistory]);

  /* ─────────────────────────────────────────────────────
     「↪︎ 津波を引き起こした地震」— 津波カードの右下ボタン。

     判定方法(ユーザー指定の方式):
     1. 選択中の津波情報が属する「一連の津波現象」(最初の警報・注意報・予報〜
        解除まで)を特定する。厳密な系列IDは無いので、直近一覧+過去一覧を
        時刻順に並べ、選択中の情報から過去へ辿って、隣り合う発表の間隔が
        24時間以内で続く限りひとつながりの現象とみなす(24時間以上の空きが
        あればそこで別の現象として区切る)、という簡易ヒューリスティックを使う。
     2. その現象の「最初の発表時刻」の30分前〜その時刻までを検索窓とし、
        気象庁 震度データベース(eqdb)でこの窓に発生した地震を検索する。
     3. 該当した地震のうち、規模(M)が最大のものを「津波を引き起こした地震」
        と特定する。
     4. eqdbで見つからず、かつ第1報の発表から3日以内の現象であれば、eqdbへの
        反映が間に合っていないだけの可能性があるため、代わりにP2P地震情報
        (直近の地震情報フィード)側から同じ時間窓で探し直す
        (findCausingQuakeFromP2p参照)。
     ───────────────────────────────────────────────────── */
  // 形: { [tsunamiId]: { status: "loading"|"done"|"notfound"|"error", quake: card|null } }
  const [causingQuakeState, setCausingQuakeState] = useState({});
  // 現在「引き起こした地震」のカードを表示中の津波ID(nullなら通常の津波カード表示)
  const [showingCausingQuakeFor, setShowingCausingQuakeFor] = useState(null);
  // 引き起こした地震の観測点一覧が「階層表示」設定の時に使う、開いている震度キー
  // (StationPointsListの通常の観測点一覧(stationDetailOpenKey)とは別に持つ)。
  const [causingQuakeStationOpenKey, setCausingQuakeStationOpenKey] = useState(null);
  // 選択中の津波情報が変わったら(別の情報を選び直した/選択解除した)、
  // 「引き起こした地震」の表示は必ず一旦引っ込める(別の津波情報のまま古い結果が
  // 表示され続けるのを防ぐ)。
  useEffect(() => {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
  }, [selectedTsunamiId]);

  // 表示中の「引き起こした地震」が変わるたび、App側(地図表示用)に通知する。
  // 見つかっていない・読み込み中・選択解除されている間はnullを通知して地図から消す。
  useEffect(() => {
    if (showingCausingQuakeFor == null) {
      onCausingQuakeChange?.(null);
      return;
    }
    const st = causingQuakeState[showingCausingQuakeFor];
    onCausingQuakeChange?.(st && st.status === "done" ? st.quake : null);
  }, [showingCausingQuakeFor, causingQuakeState, onCausingQuakeChange, active]);

  // 「戻る」を押した時に呼ぶ。表示を引っ込めるだけでなく、キャッシュ済みの
  // 結果も消して表示をクリアする(再度ボタンを押すとまた最初から検索し直す)。
  function handleBackFromCausingQuake() {
    setShowingCausingQuakeFor(null);
    setCausingQuakeStationOpenKey(null);
    if (selectedTsunamiId != null) {
      setCausingQuakeState(prev => {
        const next = { ...prev };
        delete next[selectedTsunamiId];
        return next;
      });
    }
  }

  // 津波タブ版の「戻る」ボタン。地震タブのhandleBackFromQuakeと同じ考え方で、
  // 「引き起こした地震」を表示中ならまずそれを閉じて予報区一覧に戻し、
  // 何も開いていなければ津波情報の選択自体を解除して一覧に戻る。
  function handleBackFromTsunami() {
    if (showingCausingQuakeFor != null) {
      handleBackFromCausingQuake();
      return;
    }
    if (selectedTideStationCode != null) {
      onSelectTideStation?.(null);
      return;
    }
    onSelectTsunami(null);
  }
  const backFromTsunamiLabel = showingCausingQuakeFor != null
    ? "予報区一覧に戻る"
    : (tsunamiViewMode === "tidegauge" && selectedTideStationCode != null)
    ? "観測点一覧に戻る"
    : "津波情報一覧に戻る";
  // 観測点表示切替ボタンは、「引き起こした地震」が実際に見つかった時だけ出す
  // (読み込み中・見つからなかった時・エラー時は観測点自体が無いので出さない)。
  const causingQuakeFound = showingCausingQuakeFor != null && causingQuakeState[showingCausingQuakeFor]?.status === "done";

  // 現在進行形で有効な(解除されていない)津波情報。App側の同名の計算(地図の
  // 予報区塗り分け用)と同じ考え方で、ここでは「潮位観測点オンオフボタン」を
  // 出すかどうかの判定にだけ使う。
  // tsunamisは新しい順にソート済みなので、一番新しい1件だけを見る。以前は
  // find(t => !t.cancelled)としており、一番新しい報が「解除」だった場合に
  // それを読み飛ばして1つ前の(すでに解除済みの)警報を「現在進行形」として
  // 扱ってしまっていた(解除後も古い警報の表示が残り続けるバグ)。
  const newestTsunami = tsunamis[0] || null;
  const activeTsunami = newestTsunami && !newestTsunami.cancelled ? newestTsunami : null;
  // 潮位観測点の自動表示は、有効な津波情報がある間・かつ「引き起こした地震」を
  // 見ていない間だけ提供する(引き起こした地震を見ている間は、その地震の震度観測点
  // 用に同じボタン枠を使っているため)。

  async function handleFindCausingQuake(tsunamiCard) {
    const id = tsunamiCard.id;
    setShowingCausingQuakeFor(id);
    if (causingQuakeState[id]?.status === "loading" || causingQuakeState[id]?.status === "done") return;
    setCausingQuakeState(prev => ({ ...prev, [id]: { status: "loading", quake: null } }));
    try {
      const allCards = dedupeTsunamiList([...(tsunamis || []), ...(tsunamiHistory?.items || [])]);
      const sorted = [...allCards].sort((a, b) => new Date(a.time) - new Date(b.time));
      const idx = sorted.findIndex(c => c.id === id);
      let episodeStart = idx >= 0 ? new Date(sorted[idx].time) : new Date(tsunamiCard.time);
      const GAP_LIMIT_MS = 24 * 60 * 60 * 1000; // 24時間以上の空きで別の現象とみなす
      for (let i = idx; i > 0; i--) {
        const cur = new Date(sorted[i].time);
        const prevTime = new Date(sorted[i - 1].time);
        if (cur.getTime() - prevTime.getTime() > GAP_LIMIT_MS) break;
        episodeStart = prevTime;
      }

      const winEnd = episodeStart;
      const winStart = new Date(episodeStart.getTime() - 30 * 60 * 1000);
      const pad2 = n => String(n).padStart(2, "0");
      const dateStr = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      const timeStr = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

      const { list, errMsg } = await fetchEqdbSearch({
        startDate: dateStr(winStart), startTime: timeStr(winStart),
        endDate: dateStr(winEnd), endTime: timeStr(winEnd),
        minMag: 0, maxInt: "1", sort: "S3", epi: "99", // S3: 地震の規模(M)の大きい順
      });
      if (!errMsg && list && list.length > 0) {
        const top = list[0]; // 規模が最大の1件
        const [detail, geo] = await Promise.all([fetchEqdbEventCached(top.id), loadGeoData()]);
        if (detail) {
          const card = buildEqdbQuakeCard(detail, top, stations, geo?.areas);
          setCausingQuakeState(prev => ({ ...prev, [id]: { status: "done", quake: card } }));
          return;
        }
      }

      // 気象庁 震度データベース(eqdb)で見つからなかった場合、この現象の発表(第1報)
      // から3日以内であれば、まだデータベースに反映されていないだけの可能性がある。
      // その場合は代わりにP2P地震情報(直近の地震情報フィード)側から同じ時間窓で
      // 探し、見つかればそちらを採用する。
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
      const isRecentEpisode = (Date.now() - winEnd.getTime()) <= THREE_DAYS_MS;
      if (isRecentEpisode) {
        const p2pMatch = await findCausingQuakeFromP2p(winStart, winEnd);
        if (p2pMatch) {
          const geo2 = await loadGeoData(); // キャッシュ済みのため実質即座に解決する
          const resolvedPoints = resolveStationPoints(p2pMatch.points, stations, geo2?.areas);
          setCausingQuakeState(prev => ({ ...prev, [id]: { status: "done", quake: { ...p2pMatch, resolvedPoints } } }));
          return;
        }
      }

      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "notfound", quake: null } }));
    } catch (err) {
      console.error("津波を引き起こした地震の検索に失敗:", err);
      setCausingQuakeState(prev => ({ ...prev, [id]: { status: "error", quake: null } }));
    }
  }

  // 「この震源の近傍で発生した地震」パネルを開いている場合の、震源地名。
  // nullなら通常の地震詳細カードを表示し、震源地名(文字列)が入っている間は
  // 代わりにNearbyQuakesPanelを表示する。選択解除(戻るボタンで一覧に戻る等)
  // されたら一緒に閉じる。
  const [nearbyQuakeFor, setNearbyQuakeFor] = useState(null);
  // 「近傍で発生した地震」ボタンを押した、元の地震のID。
  // 近傍一覧から別の地震を選んで詳細を見た後、一覧に「戻る」時にはこのIDの地震を
  // 選択し直す(=一覧を開いていた時点の地震に選択・観測点・凡例を揃える)ために使う。
  // 一覧自体から「戻る」を押して元の地震の詳細に戻ったらクリアする。
  const [nearbyOriginId, setNearbyOriginId] = useState(null);
  // 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いている場合の、その震度キー。
  // StationPointsList内の✕ボタンだけでなく、フローティングの外にある丸い
  // 「戻る」ボタンでも閉じられるようにするため、stateをここ(親)に持ち上げている。
  const [stationDetailOpenKey, setStationDetailOpenKey] = useState(null);
  // 「この地震の詳細」(発震機構解)画面を開いているかどうか。
  // stationDetailOpenKeyと同様、外の「戻る」ボタンで閉じられるよう親に持ち上げている。
  const [mechDetailOpen, setMechDetailOpen] = useState(false);
  useEffect(() => {
    if (selectedQuakeId == null) {
      setNearbyQuakeFor(null);
      setNearbyOriginId(null);
      setStationDetailOpenKey(null);
      setMechDetailOpen(false);
    }
  }, [selectedQuakeId]);

  /* ─────────────────────────────────────────────────────
     震央分布(地図上に丸で重ねて表示し、タップで選択できるようにする機能)。
     P2P地震一覧(quakes)・近傍地震検索(NearbyQuakesPanel)・データベース検索
     (QuakeSearchPanel)のうち、「今どれを表示中か」に応じて1つだけをMapCanvasに
     渡す。個別の地震を選択して詳細を見ている間は、震源のバツ印だけで十分なため
     分布は消す。
     近傍・検索の2つは、生の一覧に座標が無く、子コンポーネント側で
     バックグラウンド解決した点をonPointsChangeで受け取って保持している。
     ───────────────────────────────────────────────────── */
  const [nearbyEpicenterPoints, setNearbyEpicenterPoints] = useState([]);
  const [searchEpicenterPoints, setSearchEpicenterPoints] = useState([]);
  // 震央分布の丸を、まだ全件分バックグラウンド解決しきっていない間のフラグ。
  // 地図側でローディング表示を出すために使う。
  const [nearbyEpicenterLoading, setNearbyEpicenterLoading] = useState(false);
  const [searchEpicenterLoading, setSearchEpicenterLoading] = useState(false);

  const selectedForMap = quakes.find(q => q.id === selectedQuakeId)
    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

  const activeEpicenterPoints = useMemo(() => {
    if (!epicenterCirclesEnabled) return []; // 設定でOFFなら常に非表示
    if (active !== "quake") return [];
    if (nearbyQuakeFor) return nearbyEpicenterPoints;
    if (selectedForMap) return []; // 個別の地震の詳細表示中は分布を出さない
    if (quakeViewMode === "search") return searchEpicenterPoints;
    return quakes
      .filter(q => Number.isFinite(q.latitude) && Number.isFinite(q.longitude))
      .map(q => ({
        id: q.id,
        latitude: q.latitude,
        longitude: q.longitude,
        magnitude: q.magnitude,
        maxIntensityKey: q.maxIntensity,
        time: q.time,
        depth: q.depth,
        place: q.place,
      }));
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterPoints, selectedForMap, quakeViewMode, searchEpicenterPoints, quakes]);

  useEffect(() => {
    onEpicenterPointsChange?.(activeEpicenterPoints);
  }, [activeEpicenterPoints]);

  // 震央分布の丸がまだ読み込み中かどうかも、表示中の分布(近傍/検索)に応じて同様に選ぶ。
  const activeEpicenterLoading = useMemo(() => {
    if (!epicenterCirclesEnabled) return false;
    if (active !== "quake") return false;
    if (nearbyQuakeFor) return nearbyEpicenterLoading;
    if (selectedForMap) return false;
    if (quakeViewMode === "search") return searchEpicenterLoading;
    return false;
  }, [epicenterCirclesEnabled, active, nearbyQuakeFor, nearbyEpicenterLoading, selectedForMap, quakeViewMode, searchEpicenterLoading]);

  useEffect(() => {
    onEpicenterLoadingChange?.(activeEpicenterLoading);
  }, [activeEpicenterLoading]);

  // 地震タブの「戻る」ボタン(フローティングの外にある丸ボタン)の挙動。
  // 手前で開いている画面から順に閉じていくスタック式:
  //   1. 「この地震の詳細」(発震機構解)画面を開いていれば、まずそれを閉じる
  //   2. 「各地の震度」の詳細画面(震度キーごとの地域一覧)を開いていれば、それを閉じる
  //   3. 「近傍の地震」一覧を開いていれば、それを閉じる
  //   4. 近傍一覧から選んだ地震の詳細を見ていれば、元の地震の近傍一覧に戻す
  //   5. どれでもなければ、選択解除して一覧に戻る
  // ✕ボタン(StationPointsList内)はこれとは別に残したままにしている。
  function handleBackFromQuake() {
    killScrollMomentum();
    if (mechDetailOpen) {
      setMechDetailOpen(false);
      return;
    }
    if (stationDetailOpenKey != null) {
      setStationDetailOpenKey(null);
      return;
    }
    if (nearbyQuakeFor) {
      setNearbyQuakeFor(null);
      setNearbyOriginId(null);
      setSnapIndex(1);
      return;
    }
    if (nearbyOriginId) {
      // 近傍一覧から選んだ地震の詳細から、一覧に戻る。
      // 選択自体も元の地震に戻すことで、観測点・凡例・地図上のバツ印を
      // 一覧を開いていた時点の地震に揃える(戻さないと、一覧の裏で
      // 選んだ地震のデータがそのまま残ってしまう)。
      const originQuake = quakes.find(q => q.id === nearbyOriginId)
        || (searchQuake && searchQuake.id === nearbyOriginId ? searchQuake : null);
      if (originQuake) {
        pendingNearbyScrollRestoreRef.current = true;
        onSelectQuake(nearbyOriginId);
        setNearbyQuakeFor(originQuake.place);
      } else {
        setNearbyOriginId(null);
      }
      setSnapIndex(3);
      return;
    }
    onSelectQuake(null);
    // リアルタイムタブの「直近の地震」一覧に戻る時だけ、フローティングの高さを
    // タブを開いた時と同じ「中中」に揃える(地震タブ側は、詳細を見ていた高さを
    // そのまま維持する従来の挙動を変えない)。
    if (active === "realtime") setSnapIndex(2);
  }
  const backFromQuakeLabel =
    mechDetailOpen ? "地震の詳細に戻る" :
    stationDetailOpenKey != null ? "地震の詳細に戻る" :
    nearbyQuakeFor ? "地震の詳細に戻る" :
    nearbyOriginId ? "近傍地震一覧に戻る" :
    "地震一覧に戻る";

  // 気象庁 震度データベース検索フォーム・結果一覧の状態。
  // QuakeSearchPanel自身の内部state(useState)ではなくここに持たせているのは、
  // 地震を選択すると一覧側(QuakeSearchPanel)がいったんアンマウントされるため
  // (選択中は代わりにQuakeDetailCard等を表示する排他表示になっている)。
  // 「戻る」ボタンで選択解除して一覧に戻った時に、検索結果や入力条件が
  // 消えてしまわないよう、アンマウントされないBottomDock側で保持する。
  const [eqdbSearch, setEqdbSearch] = useState(() => {
    const { start, end } = defaultEqdbDateRange();
    return {
      startDate: start, endDate: end,
      minMag: "0.0", maxInt: "1", sort: "S0", epicenterName: "",
      status: "", isSearching: false, hasSearched: false,
      results: [], loadingId: null,
    };
  });

  // 一覧(未選択状態)のスクロール位置を覚えておくためのref。
  // 地震を選択するとカード表示に排他的に切り替わり(keyが変わり)一覧側のDOM要素
  // ごと作り直されるため、選択した瞬間のスクロール位置を保存しておかないと、
  // 「戻る」で一覧に戻った時に必ず先頭に戻ってしまう。選択操作の直前
  // (handleSelectQuakeForScroll)で保存し、選択解除(戻る)で復元する。
  const listScrollTopRef = useRef(0);
  function handleSelectQuakeForScroll(id) {
    if (scrollRef.current) listScrollTopRef.current = scrollRef.current.scrollTop;
    killScrollMomentum();
    // 今見ているタブ(地震タブ/リアルタイムタブ)を選択のoriginとして渡す。
    // これにより、地震タブで選んだ地震がリアルタイムタブに、リアルタイムタブで
    // 選んだ地震が地震タブに、それぞれ反映されないようにする(App側で判定)。
    onSelectQuake(id, active);
    setSnapIndex(1);
  }

  // 津波タブ版のhandleSelectQuakeForScroll。地震タブと同じく、選択した瞬間に
  // パネルの高さを「中」に揃える。
  function handleSelectTsunamiForScroll(id) {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    killScrollMomentum();
    onSelectTsunami(id);
    setSnapIndex(1);
  }

  // 近傍地震一覧のスクロール位置。一覧→他の地震の詳細→一覧、と行き来する際、
  // NearbyQuakesPanel自体はDOMごと作り直される(=スクロール位置は自然には
  // 残らない)ため、一覧から離れる直前に保存しておき、一覧に戻ってきた時だけ
  // 復元する。pendingNearbyScrollRestoreRefは「次にスクロール位置を調整する
  // タイミングでは、0にリセットするのではなくこちらを復元してほしい」という
  // 1回限りの合図。
  const nearbyListScrollTopRef = useRef(0);
  const pendingNearbyScrollRestoreRef = useRef(false);

  // タブ切り替え、一覧⇄検索モードの切り替え、地震の選択/選択解除で表示中身が
  // 変わるたびに、ブラウザのスクロールアンカリングによりscrollTopが勝手に動き、
  // カードやヘッダーが隠れて見えることがあるため、そのたびに明示的にスクロール
  // 位置を調整する。
  // ただし「戻る」ボタンで選択解除して一覧に戻っただけ(タブ・モードは変わって
  // いない)場合は、先頭に戻すのではなく選択前のスクロール位置を復元する
  // (=一覧を下の方までスクロールして地震を選んだ後、戻ったら同じ場所に
  //  留まってほしい、という自然な挙動にするため)。
  const prevScrollDepsRef = useRef({ active, quakeViewMode, tsunamiViewMode, selectedQuakeId });
  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const prev = prevScrollDepsRef.current;
    const onlyDeselected =
      prev.active === active && prev.quakeViewMode === quakeViewMode && prev.tsunamiViewMode === tsunamiViewMode &&
      prev.selectedQuakeId != null && selectedQuakeId == null;

    // scrollTopを直接設定するだけで、一覧⇄詳細切り替え時の位置調整は十分。
    // 以前はここでoverflowをhidden→autoと切り替えていたが、iOS Safariで
    // ボタン要素(地震一覧の各行)がスクロールを受け付けなくなる不具合の
    // 原因になっていたため廃止した(killScrollMomentum側も参照)。
    const el = scrollRef.current;
    if (pendingNearbyScrollRestoreRef.current) {
      el.scrollTop = nearbyListScrollTopRef.current;
      pendingNearbyScrollRestoreRef.current = false;
    } else {
      el.scrollTop = onlyDeselected ? listScrollTopRef.current : 0;
    }
    prevScrollDepsRef.current = { active, quakeViewMode, tsunamiViewMode, selectedQuakeId };
    // settingsPath(設定の階層メニュー内の画面遷移。例: ライセンス一覧→個別ライセンス詳細)や
    // stationDetailOpenKey(「各地の震度」の詳細画面)は、同じscrollRefを共有したまま
    // 中身の高さだけ変わる。これらの変化時にscrollTopをリセットしないと、深くスクロール
    // した状態で戻った時、新しい(短い)中身に対して古い(大きい)scrollTopが残ったままになり、
    // 中身が全部スクロールアウトして「フローティング内が何も表示されない」ように見える不具合が起きる。
  }, [active, selectedQuakeId, quakeViewMode, tsunamiViewMode, nearbyQuakeFor, settingsPath, stationDetailOpenKey, mechDetailOpen]);


  // 画面の高さ — 「全画面」スナップの基準になる
  const [viewportH, setViewportH] = useState(() =>
    typeof window !== "undefined" ? window.innerHeight : 800
  );
  useEffect(() => {
    function onResize() { setViewportH(window.innerHeight); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const NAV_ROW_HEIGHT  = 66; // ナビ行の固定高さ(58pxボタン + 上下4pxパディング)
  const BOTTOM_OFFSET   = 32; // 親側の bottom:16px+safeArea の概算
  const TOP_GAP         = 56; // 全画面時に画面最上部へ残す余白

  // ハンドル行の高さ(HANDLE_HEIGHT)を変更した場合の差分。
  // 各スナップの固定高さは元々HANDLE_HEIGHT=18px前提で調整済みなので、
  // ここで差分を加算しておくことで、将来ハンドルの高さを変えても
  // 中身の表示領域(ここが本質)は変えずに済むようにしている。
  // 現在はHANDLE_HEIGHT=18のためこの差分は0。
  const HANDLE_HEIGHT_DELTA = HANDLE_HEIGHT - 18;

  // 0:低(閉) 1:中 2:中中 3:中高 4:高 5:全画面
  // 「高」「全画面」は、以前は表示中のタブの中身の実測高さ(naturalHeight)を
  // 元に計算していたが、これだと地震タブ(地震の件数や「各地の震度」展開で
  // 中身の長さが大きく変動する)だけ、気象/津波/警報/設定タブ(常に同じ
  // 「地図レイヤー」一覧を表示)と「高」「全画面」の高さがズレてしまっていた。
  // → タブごとの中身の長さには一切依存させず、常に同じ固定値/画面基準の
  //    値にすることで、どのタブでも「高」「全画面」が同じ高さになるようにする。
  //    中身がその高さより長い場合は、パネル内部のスクロール(scrollRef)に任せる。
  const highHeight = 390 + HANDLE_HEIGHT_DELTA; // 「高」の固定高さ(px)。地図レイヤー一覧(6項目)相当の目安(旧: 350)
  const fullscreenContentHeight = viewportH - TOP_GAP - BOTTOM_OFFSET - NAV_ROW_HEIGHT;

  // 「中」「中高」はタブによらず常に同じ高さになるよう固定pxで持つ
  // (地図レイヤー一覧で調整済みだった見た目の高さをそのまま定数化している)。
  const MID_FIXED     = 115 + HANDLE_HEIGHT_DELTA; // 「中」の固定高さ(px)
  // 「中中」の固定高さ(px)。「中」と「中高」の間に設ける中間スナップ。
  const MIDMID_FIXED = 200 + HANDLE_HEIGHT_DELTA;
  // 「中高」の固定高さ(px)。設定タブのトップメニュー(ヘッダー+5項目のカード)や、
  // 地震タブの検索フォーム(検索ボタンまで)がスクロールなしで丸ごと収まる高さを
  // 基準に調整している(旧: 222px)。検索フォーム側を見た目のバランスを保ちつつ
  // コンパクトに詰めることで、この高さのまま検索ボタンまで収まるようにしている。
  const MIDHIGH_FIXED = 290 + HANDLE_HEIGHT_DELTA;
  const GAP           = 20;  // 各スナップ間に必ず確保する最低差(px)
  const midHeight     = Math.min(MID_FIXED, highHeight - GAP * 2);
  const midHighHeight = Math.max(
    Math.min(MIDHIGH_FIXED, highHeight - GAP),
    midHeight + GAP
  );
  const midMidHeight = Math.max(
    Math.min(MIDMID_FIXED, midHighHeight - GAP),
    midHeight + GAP
  );

  // 地震を選択した直後にスナップする「低(カードのみ)」の高さ。
  // 完全に閉じる(0)ではなく、QuakeDetailCard 1枚(+ハンドル)がちょうど収まる
  // 高さにして、地図の震源付近が広く見えつつカードも確認できるようにする。
  const CARD_ONLY_HEIGHT = 96 + HANDLE_HEIGHT_DELTA; // QuakeDetailCard 1枚の実測目安(margin込み)
  const quakeLowHeight = Math.min(CARD_ONLY_HEIGHT, midHeight - GAP);

  const SNAP_HEIGHTS = [
    0,
    midHeight,
    midMidHeight,
    midHighHeight,
    highHeight,
    Math.max(fullscreenContentHeight, highHeight),
  ];
  // フローティングは、アプリを開いた最初から開いた状態にする(閉じた状態の
  // 0からは始めない)。開く高さは、タブ切り替え時と同じ基準
  // (リアルタイムタブは「中中」、それ以外は「中高」)に揃える。
  const [snapIndex, setSnapIndex] = useState(() => active === "realtime" ? 2 : 3);

  // 「今、自分(タブタップの開閉トグル)が開いた状態にしているか」を表すref。
  // タブ切り替えで開いた場合もここを立てておくことで、直後の同じタブの再タップで
  // 正しく閉じられるようにする(現在のsnapIndexの読み取りには依存しない)。
  // フローティングは最初から開いた状態で始まるため、初期値もtrueにしておく
  // (falseのままだと、起動直後の最初のタップが「閉じる」ではなく「開く」
  // (無変化)になってしまう)。
  const openedByTapRef = useRef(true);

  // 別のタブに切り替えた時は、フローティングを「中高」まで開く。
  // (同じタブを再タップした時の開閉トグルとは別物なので、prevActiveRefで
  // 「本当にタブが変わった時だけ」を判定している)
  // ただし、緊急地震速報の詳細を表示していて(eewDetailOpen)、かつフローティングが
  // 既に開いている(snapIndex !== 0)間は、タブを切り替えてもこの自動オープンを
  // 起こさない。EEW表示中に他のタブのボタンを押しても、開いているパネルの高さが
  // 勝手に変わらないようにするため。フローティングが閉じている時は、EEW表示中でも
  // このガードの対象外とする(閉じた状態を維持するだけなので、タブ切り替えの
  // 邪魔にはならない)。
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (prevActiveRef.current !== active) {
      if (!(eewDetailOpen && snapIndex !== 0)) {
        killScrollMomentum();
        // リアルタイムタブだけは、他のタブより一段低い「中中」で開く。
        setSnapIndex(active === "realtime" ? 2 : 3);
        openedByTapRef.current = true;
      }
    }
    prevActiveRef.current = active;
  }, [active, eewDetailOpen, snapIndex]);

  // 緊急地震速報の詳細が開かれた瞬間、フローティングの高さを自動で「中中」にする。
  // EEWの内容(震源・予測震度など)が見える程度に開きつつ、地図もある程度隠れずに
  // 見える高さとしてちょうどいいため。閉じた時の高さの復元は行わない
  // (EEWは緊急性が高く、閉じた後にどの高さへ戻すべきかが自明ではないため)。
  const prevEewDetailOpenRef = useRef(eewDetailOpen);
  useEffect(() => {
    if (!prevEewDetailOpenRef.current && eewDetailOpen) {
      killScrollMomentum();
      setSnapIndex(2);
      openedByTapRef.current = true;
    }
    prevEewDetailOpenRef.current = eewDetailOpen;
  }, [eewDetailOpen]);

  // FAB(!ボタン)を押すたびに増える信号。eewDetailOpenが既にtrueのまま(例: 手元で
  // フローティングだけ閉じていた状態で、もう一度!ボタンを押して確認し直したい時)
  // だと上のuseEffectの「falseからtrueへの変化」という条件に引っかからず、
  // パネルが開き直されない(上部が見切れたまま/閉じたままになる)ことがあったため、
  // 値が変わるたびに必ず開き直す専用の信号として分けている。
  const isFirstEewOpenSignalRender = useRef(true);
  useEffect(() => {
    if (isFirstEewOpenSignalRender.current) {
      isFirstEewOpenSignalRender.current = false;
      return;
    }
    killScrollMomentum();
    setSnapIndex(2);
    openedByTapRef.current = true;
  }, [eewOpenSignal]);

  // タブバーで、既にアクティブなタブがもう一度タップされた時(navCollapseSignalの変化で検知)、
  // フローティングを開閉トグルする。前回タップ(またはタブ切り替え)で自分が開いたかどうかを
  // refで直接管理し、現在のsnapIndexの読み取り(ドラッグ操作等の影響を受けうる)には依存しないようにする。
  const isFirstNavCollapseRender = useRef(true);
  useEffect(() => {
    if (isFirstNavCollapseRender.current) {
      isFirstNavCollapseRender.current = false;
      return;
    }
    killScrollMomentum();
    // 緊急地震速報の詳細を表示中は、同じタブの再タップによる開閉トグルで
    // フローティングを閉じてしまわないようにする(EEWの内容を見せ続けるため)。
    // 閉じている(snapIndex===0)状態からの場合だけ、詳細が見える高さまで開く。
    if (eewDetailOpen) {
      openedByTapRef.current = true;
      if (snapIndex === 0) setSnapIndex(2);
      return;
    }
    if (openedByTapRef.current) {
      openedByTapRef.current = false;
      setSnapIndex(0);
    } else {
      openedByTapRef.current = true;
      // リアルタイムタブだけは、他のタブより一段低い「中中」で開く。
      setSnapIndex(active === "realtime" ? 2 : 3);
    }
  }, [navCollapseSignal]);

  // タブバーで、既にアクティブなタブをダブルタップした時、フローティングを一気に
  // 「高」(中高のひとつ上)まで開く。
  const isFirstNavDoubleTapRender = useRef(true);
  useEffect(() => {
    if (isFirstNavDoubleTapRender.current) {
      isFirstNavDoubleTapRender.current = false;
      return;
    }
    killScrollMomentum();
    openedByTapRef.current = true;
    setSnapIndex(4);
  }, [navDoubleTapSignal]);

  // 親から渡される layerOpen(真偽値)を 低(0)⇄高(4) として反映する。
  // ドラッグで内部的に決めたスナップを、ここで二重に上書きしないようrefで判定する。
  const lastLayerOpen = useRef(layerOpen);
  useEffect(() => {
    if (layerOpen !== lastLayerOpen.current) {
      lastLayerOpen.current = layerOpen;
      setSnapIndex(layerOpen ? (active === "quake" ? 3 : 4) : 0);
    }
  }, [layerOpen, active]);

  // 震央分布(地図上の丸)をタップして地震を選択した時も、一覧内から選んだ時
  // (handleSelectQuakeForScroll)と同じく、フローティングの高さを「中」に揃える。
  // mapSelectSignalは「丸がタップされるたびに1増える」だけの値なので、
  // 初回マウント時(値が変わっていない)には反応しないようにしておく。
  const lastMapSelectSignal = useRef(mapSelectSignal);
  useEffect(() => {
    if (mapSelectSignal !== lastMapSelectSignal.current) {
      lastMapSelectSignal.current = mapSelectSignal;
      setSnapIndex(1);
      // 近傍の地震一覧を開いたまま丸をタップした場合、一覧側の表示を優先してしまい
      // (a)フローティングに選んだ地震の詳細が出ない (b)他の丸が消えない、という
      // 2つの不具合につながるため、丸タップでの選択は一覧表示(nearbyQuakeFor)を
      // 閉じる。ただしnearbyOriginIdは残す — これは一覧内の行をタップして選んだ時
      // (NearbyQuakesPanelのonSelectQuake)と同じ挙動で、これを消してしまうと
      // 「戻る」を押した時に近傍一覧へ戻れず、最初の画面まで戻ってしまう。
      setNearbyQuakeFor(null);
    }
  }, [mapSelectSignal]);

  // 潮位観測点ピン(発令中の予報区分。潮位計モードでない間に自動表示しているもの)を
  // 地図上でタップした時、わざわざ「潮位計」モードへ切り替えてしまうと、見終わった後
  // また元のモード(直近の津波情報一覧など)へ手動で戻す一手間が発生してしまう。
  // そのため、tsunamiViewModeは変えずに(=見ていたモードのまま)、その場で観測点の
  // 詳細を表示する(TsunamiSection側でselectedTideStationCodeの有無を
  // viewModeより優先して判定するように変更している)。震央分布の丸タップ
  // (mapSelectSignal)と同じく「タップのたびに1増えるだけの値」パターンで、
  // 初回マウント時には反応しない。ここではフローティングの高さの調整だけ行う。
  const lastTideStationSelectSignal = useRef(tideStationSelectSignal);
  useEffect(() => {
    if (tideStationSelectSignal !== lastTideStationSelectSignal.current) {
      lastTideStationSelectSignal.current = tideStationSelectSignal;
      setSnapIndex(4); // 潮位の詳細がしっかり見えるよう「高」の高さに揃える
    }
  }, [tideStationSelectSignal]);

  // 地震の選択が「あり→なし」に変わった(=戻るボタンで選択解除された)ら、
  // 詳細カード表示の「中」から一覧表示の「中高」へ戻す。
  const lastSelectedQuakeId = useRef(selectedQuakeId);
  useEffect(() => {
    if (lastSelectedQuakeId.current != null && selectedQuakeId == null) {
      setSnapIndex(3);
    }
    lastSelectedQuakeId.current = selectedQuakeId;
  }, [selectedQuakeId]);

  // 津波タブ版。考え方は地震タブとまったく同じ。
  const lastSelectedTsunamiId = useRef(selectedTsunamiId);
  useEffect(() => {
    if (lastSelectedTsunamiId.current != null && selectedTsunamiId == null) {
      setSnapIndex(3);
    }
    lastSelectedTsunamiId.current = selectedTsunamiId;
  }, [selectedTsunamiId]);

  // 設定タブを開いた瞬間は、常にパネルの高さを「中高」にする
  // (トップメニューがスクロールなしで丸ごと見える高さのため)。
  // 設定タブから抜ける時も、行き先のタブに関わらず同じく「中高」にする
  // (他のタブ切り替え全般と同じ、通常の開閉挙動に揃えている)。
  // ただし、緊急地震速報の詳細を表示中(eewDetailOpen)は、この高さ強制を
  // 行わない。EEW表示中に設定タブへ切り替えても、フローティングの高さが
  // 勝手に変わらないようにするため(タブ切り替え全般でのeewDetailOpen中の
  // 挙動を、他のタブ切り替えガードと揃えている)。
  const lastActiveForSettings = useRef(active);
  useEffect(() => {
    if (eewDetailOpen) {
      lastActiveForSettings.current = active;
      return;
    }
    if (
      (lastActiveForSettings.current !== "settings" && active === "settings") ||
      (lastActiveForSettings.current === "settings" && active !== "settings")
    ) {
      setSnapIndex(3);
    }
    lastActiveForSettings.current = active;
  }, [active, eewDetailOpen]);

  // 津波警報テスト配信の「地図タップで選択」モード。ONになった瞬間、その時点の
  // 高さを覚えたうえでフローティングを完全にたたみ(低=0)、地図全体をタップできる
  // ようにする。OFFに戻った瞬間(予報区を選び終えた時・キャンセルした時のどちらも
  // App側ではtsunamiAreaPickActive=falseにするだけなので、ここでは真偽値の変化だけを
  // 見て判定する)、覚えておいた高さへ自動的に戻す。
  const preTsunamiPickSnapIndexRef = useRef(snapIndex);
  const lastTsunamiAreaPickActive = useRef(tsunamiAreaPickActive);
  useEffect(() => {
    if (!lastTsunamiAreaPickActive.current && tsunamiAreaPickActive) {
      preTsunamiPickSnapIndexRef.current = snapIndex; // ピック開始直前の高さを覚えておく
      setSnapIndex(0);
    } else if (lastTsunamiAreaPickActive.current && !tsunamiAreaPickActive) {
      setSnapIndex(preTsunamiPickSnapIndexRef.current); // 覚えておいた高さに戻す
    }
    lastTsunamiAreaPickActive.current = tsunamiAreaPickActive;
  }, [tsunamiAreaPickActive]);

  function handleSnap(newIndex) {
    setSnapIndex(newIndex);
    const shouldOpen = newIndex > 0;
    if (shouldOpen !== layerOpen) {
      lastLayerOpen.current = shouldOpen;
      onLayerOpenChange(shouldOpen);
    }
  }

  const { height: currentHeight, isDragging, handlePointerDown } =
    useSnapDrag({ heights: SNAP_HEIGHTS, index: snapIndex, onSnap: handleSnap });

  // 開閉トランジション・ドラッグ中だけ軽量モードにする:
  // border-radius / height のような「レイアウトに影響するプロパティ」を
  // 大きく・複雑な屈折フィルタ付きの要素でアニメーションさせると、
  // ブラウザがフレームごとにbackdrop-filter+SVGフィルタを再計算するため重くなる。
  // 動いている間だけ屈折SVGフィルタを外し、blurも軽くして、
  // 静止したら元のリッチな質感に戻す。
  const [settled, setSettled] = useState(true);
  const settleTimer = useRef(null);
  function scheduleSettle(delay = 460) {
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => setSettled(true), delay);
  }
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
    return () => clearTimeout(settleTimer.current);
  }, [snapIndex]);
  useEffect(() => {
    if (isDragging) { setSettled(false); clearTimeout(settleTimer.current); }
  }, [isDragging]);

  // タブ切り替え(active変化)でも中身の自然な高さが変わり、パネルの高さが
  // アニメーションで追従する。この高さ変化中も、スナップ切り替え時と同様に
  // 重い屈折フィルタを一時的に外して軽量モードにする。
  useEffect(() => {
    setSettled(false);
    scheduleSettle(460);
  }, [active]);

  // 角丸は「現在のガラス全体の実際の高さ」と「開き具合」から直接算出する。
  // 999pxのような巨大な値をそのままトランジションさせると、中間状態で
  // border-radiusが箱の寸法を超えてクランプされ、丸が膨らんで歪な円形に
  // なってしまうため、999は一切使わない。
  // 下の角丸はナビ行(高さ66固定)に合わせて常に33pxで一定。
  // 上の角丸は、閉じている時は下と揃えて完全な丸ピルにし(33px)、
  // 開くにつれて少しだけ締まった26pxへ滑らかに変化させる
  // — 26〜33はどちらも箱の最小高さ(66, 半分33)を超えない安全な値なので、
  // 補間の途中でも歪みは発生しない(「高」を超えて全画面へ伸びる間もtopRadiusは26で頭打ち)。
  const BOTTOM_RADIUS = NAV_ROW_HEIGHT / 2; // 33px
  // openProgressは「高」の固定高さ(highHeight)を基準にする。
  // 以前はnaturalHeight(タブごとに変わる中身の実測高さ)を分母にしていたため、
  // 同じスナップ高さでもタブによってopenProgressが変わり、地震タブだけ
  // 上の角丸が他タブと微妙に異なって見える原因になっていた。
  const openProgress = Math.min(1, Math.max(0, currentHeight / highHeight));
  const topRadius    = BOTTOM_RADIUS + (26 - BOTTOM_RADIUS) * openProgress;
  const bottomRadius = BOTTOM_RADIUS;

  /* ── ナビ行スワイプ選択（%ベース連続追従方式）────────────────
     タブは flex:1 で等幅。ハイライトの left/width は、ナビ行の
     「左右パディングを除いた内側領域」を基準にした % で一貫管理する。
     NAV_PAD_X は JSX 側の padding と必ず一致させること(ズレ防止)。
     端のタブでハイライトが外枠ぎりぎりに接しないよう、左右に
     十分な余白(NAV_PAD_X)を確保している。 */
  const NAV_PAD_X = 8; // ナビ行の左右パディング[px]。JSXのpaddingと一致させる
  const navRowRef    = useRef(null);
  const navPointerId = useRef(null);
  const navMoved     = useRef(false);
  const navStartX    = useRef(0);
  const N = NAV.length;                       // タブ数
  const tabW = 100 / N;                       // 1タブの幅 [%]（内側領域基準）

  const activeIndex = NAV.findIndex(n => n.id === active);
  const [highlightLeft, setHighlightLeft] = useState(activeIndex * tabW);
  const [navDragging,   setNavDragging]   = useState(false);
  const [navPressed,    setNavPressed]    = useState(false);  // 指が触れている間ずっとtrue(タップ/ドラッグ問わず)
  const [previewIdx,    setPreviewIdx]    = useState(null);  // ドラッグ中の最近傍index

  // active が外部から変わった時（タップ以外の切替）にハイライトを追従させる
  useEffect(() => {
    if (!navDragging) {
      setHighlightLeft(activeIndex * tabW);
    }
  }, [activeIndex, navDragging, tabW]);

  // clientX → 内側領域(左右NAV_PAD_X除外)を基準にした正規化 left [%]
  function clientXToLeft(clientX) {
    const row = navRowRef.current;
    if (!row) return activeIndex * tabW;
    const { left, width } = row.getBoundingClientRect();
    const innerLeft  = left + NAV_PAD_X;
    const innerWidth = width - NAV_PAD_X * 2;
    const ratio = Math.max(0, Math.min(1, (clientX - innerLeft) / innerWidth));
    return ratio * 100;              // % 値（内側領域基準）
  }

  // clientX に最も近いタブの index を返す
  function clientXToIndex(clientX) {
    const pct = clientXToLeft(clientX);          // 0–100（内側領域基準）
    return Math.max(0, Math.min(N - 1, Math.round(pct / tabW - 0.5)));
  }

  function handleNavPointerDown(e) {
    navPointerId.current = e.pointerId;
    navMoved.current     = false;
    navStartX.current    = e.clientX;
    e.currentTarget.setPointerCapture(e.pointerId);
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    setNavPressed(true);
    // ここでは navDragging を立てない。
    // navDragging=true は transition を切るためのフラグなので、
    // まだ指が動いていない(タップの可能性がある)段階では
    // transition を有効なままにしておき、目的のタブへ
    // スライドして移動するアニメーションを見せる。
    setHighlightLeft(idx * tabW);
  }

  function handleNavPointerMove(e) {
    if (navPointerId.current !== e.pointerId) return;
    if (Math.abs(e.clientX - navStartX.current) > 3 && !navMoved.current) {
      // ここで初めて「実際のドラッグ」と確定する。
      // この瞬間から transition を切って指に即座追従させる。
      navMoved.current = true;
      setNavDragging(true);
    }
    const idx = clientXToIndex(e.clientX);
    setPreviewIdx(idx);
    if (navMoved.current) {
      // ドラッグ確定後は、指の連続位置にハイライトを追従させる
      const raw = clientXToLeft(e.clientX) - tabW / 2;
      setHighlightLeft(Math.max(0, Math.min(100 - tabW, raw)));
    } else {
      // まだタップ相当の間はタブ中心に置いたまま(スライドで追いつく)
      setHighlightLeft(idx * tabW);
    }
  }

  function handleNavPointerUp(e) {
    if (navPointerId.current !== e.pointerId) return;
    navPointerId.current = null;
    const idx = clientXToIndex(e.clientX);
    setNavDragging(false);
    setNavPressed(false);
    setPreviewIdx(null);
    setHighlightLeft(idx * tabW);
    onNav(NAV[idx].id);
  }

  // タップ(pointermove なし)は click でも拾えるようフォールバック。
  // タップ回数(シングル/ダブル)の判定は、ここでは一切行わない。
  // 1回の物理タップに対して pointerup(handleNavPointerUp)とclick(この関数)の
  // 両方から onNav が呼ばれる点も含め、判定はすべてApp側のhandleNavTapに一本化する
  // (SideNavRailのhandleClickと同じ考え方)。以前はここにも独自のダブルタップ判定
  // (lastTapTime/DOUBLE_TAP_MS)を持っていたが、App側の判定(navCollapseSignal/
  // navDoubleTapSignal、80ms/400msの窓)と別々のタイマーが同時に動くことになり、
  // 判定窓のズレ(320ms vs 400ms)や layerOpen と snapIndex の不整合により
  // ダブルタップが効かない・動作が不安定になる原因になっていたため撤去した。
  function handleNavClick(id) {
    if (navMoved.current) return;   // ドラッグ完了後の二重発火を防ぐ

    const idx = NAV.findIndex(n => n.id === id);
    setHighlightLeft(idx * tabW);
    onNav(id);
  }

  // ドラッグ中はプレビューindex、そうでなければactiveをハイライト表示に使う
  const displayIdx = navDragging && previewIdx != null ? previewIdx : activeIndex;

  // 戻るボタンの下端オフセット。パネル本体(currentHeight)+ナビ行(NAV_ROW_HEIGHT)+
  // 少し余白、を常に足し上げているため、ドラッグ中も含めてパネルの高さに追従する。
  const backButtonBottom = currentHeight + NAV_ROW_HEIGHT + 12;

  // 緊急地震速報のFAB/戻るボタンを出すかどうか(取消済みでないEEWが1件でもあるか)。
  const hasActiveEew = eews.some(e => !e.cancelled);

  // 「戻るボタンの位置」(right:16, bottom:backButtonBottom)を、他のタブ固有の
  // 戻るボタン/切替ボタン群がすでに使っているかどうか。使っている場合だけ、
  // びっくりボタンをその左側にずらす(同時に2つ出ても重ならないようにする)。
  // eewDetailOpen中は他タブの戻るボタン自体を出さない(下の各ブロックで
  // !eewDetailOpen && を付けている)ため、ここでは判定用に元の条件だけを見る。
  const otherBackSlotOccupied =
    (active === "quake" && selectedQuakeId != null) ||
    (active === "tsunami" && (
      selectedTsunamiId != null ||
      selectedTideStationCode != null ||
      (activeTsunami != null && !causingQuakeFound)
    )) ||
    (active === "settings" && settingsPath.length > 0);

  return (
    <>
      {/* 広い画面では、SideNavRail(タブ部分)はApp側で共有のGlassの中に
          BottomDockと並べて描画するため、ここでは出さない。 */}

      {/* 緊急地震速報のFAB／戻るボタン — 通常は地震タブの戻るボタンと全く同じ位置
          (right:16, backButtonBottom)に出す。詳細表示中(eewDetailOpen)は他タブの
          戻るボタンを隠すため、この位置を独占できる。詳細表示前(FABの状態)に
          他タブの戻るボタン等がすでにその位置を使っている場合だけ、びっくりボタンを
          左にずらして重ならないようにする。
          リアルタイムタブでは、下のコンテンツ側(eewDetailOpen判定のternary)で
          アクティブな緊急地震速報を常にそのままフローティングへ表示するため、
          タップして開く/閉じるという操作自体が不要になる。そのためこのFAB/
          戻るボタン自体をリアルタイムタブでは出さない。 */}
      {hasActiveEew && active !== "realtime" && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: (!eewDetailOpen && otherBackSlotOccupied) ? wideAnchorRect.right + 12 + 56 : wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {eewDetailOpen ? (
              <BackToListButton onClick={onCloseEewDetail} label="閉じる"/>
            ) : (
              <EewFabButton onClick={onOpenEewDetail}/>
            )}
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: (!eewDetailOpen && otherBackSlotOccupied) ? 16 + 56 : 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1), right 0.25s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {eewDetailOpen ? (
            <BackToListButton onClick={onCloseEewDetail} label="閉じる"/>
          ) : (
            <EewFabButton onClick={onOpenEewDetail}/>
          )}
        </div>
        )
      )}

      {/* 戻るボタン — 地震を選択している間だけ、パネルのすぐ上に浮かぶ。
          Glass(パネル本体)の兄弟として置くことで、currentHeightの変化
          (ドラッグ含む)にそのまま追従できるようにしている。
          リアルタイムタブの「直近の地震一覧」から選んだ場合も、地震タブと
          全く同じ詳細表示になるため、この戻るボタンも同様に出す。
          緊急地震速報の詳細を表示している間は、その位置をびっくりボタン側の
          「戻る」ボタンが使うため、ここでは出さない。 */}
      {!eewDetailOpen && (active === "quake" || active === "realtime") && selectedQuakeId != null && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={handleBackFromQuake}
              label={backFromQuakeLabel}
            />
            <div style={{ marginTop: 12 }}>
              {areaFillEnabled && (
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              )}
            </div>
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <div style={{ marginBottom: 12 }}>
            {areaFillEnabled && (
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            )}
          </div>
          <BackToListButton
            onClick={handleBackFromQuake}
            label={backFromQuakeLabel}
          />
        </div>
        )
      )}

      {/* 津波タブ版。地震タブの戻るボタンと全く同じ考え方。
          ボタン群を出す条件は3通りある(いずれか1つで表示):
            1. 個別の津波情報を選択中(戻るボタン)
            2. 潮位観測点を選択中(戻るボタン。潮位計モードに限らない — 直近一覧などを
               見ながら地図の観測点ピンをタップした場合も、モードは切り替えずその場で
               詳細を出すため)
            3. 現在進行形の津波情報がある(一覧に戻るものが無くても、潮位観測点
               オンオフボタンだけは出す。「引き起こした地震」を見ている間は
               その地震の震度観測点用に同じ枠を使うため出さない)
          観測点表示切替ボタンは、「引き起こした地震」を表示している間は震度観測点用
          (stationMarkersVisible)、それ以外で有効な津波情報がある間は潮位観測点用
          (tideStationMarkersVisible)を出す。両方同時に出ることはない。 */}
      {!eewDetailOpen && active === "tsunami" && (
        selectedTsunamiId != null ||
        selectedTideStationCode != null ||
        (activeTsunami != null && !causingQuakeFound)
      ) && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            {(selectedTsunamiId != null || selectedTideStationCode != null) && (
              <BackToListButton
                onClick={handleBackFromTsunami}
                label={backFromTsunamiLabel}
              />
            )}
            {causingQuakeFound ? (
              <div style={{ marginTop: 12 }}>
                <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
              </div>
            ) : activeTsunami != null && !isViewingPastTsunami && tsunamiViewMode !== "tidegauge" && (
              <div style={{ marginTop: 12 }}>
                <StationMarkerToggleButton visible={tideStationMarkersVisible} onClick={onToggleTideStationMarkersVisible}/>
              </div>
            )}
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          {causingQuakeFound ? (
            <div style={{ marginBottom: 12 }}>
              <StationMarkerToggleButton visible={stationMarkersVisible} onClick={onToggleStationMarkersVisible}/>
            </div>
          ) : activeTsunami != null && !isViewingPastTsunami && tsunamiViewMode !== "tidegauge" && (
            <div style={{ marginBottom: 12 }}>
              <StationMarkerToggleButton visible={tideStationMarkersVisible} onClick={onToggleTideStationMarkersVisible}/>
            </div>
          )}
          {(selectedTsunamiId != null || selectedTideStationCode != null) && (
            <BackToListButton
              onClick={handleBackFromTsunami}
              label={backFromTsunamiLabel}
            />
          )}
        </div>
        )
      )}

      {/* 設定タブのサブ画面(カテゴリ/項目の中身)を見ている間だけ、同じ戻るボタンを浮かべる。 */}
      {!eewDetailOpen && active === "settings" && settingsPath.length > 0 && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            top: wideAnchorRect.top + 16,
            zIndex: 50,
          }}>
            <BackToListButton
              onClick={() => setSettingsPath(p => p.slice(0, -1))}
              label="前の画面に戻る"
            />
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          right: 16,
          bottom: backButtonBottom,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
        }}>
          <BackToListButton
            onClick={() => setSettingsPath(p => p.slice(0, -1))}
            label="前の画面に戻る"
          />
        </div>
        )
      )}

      {/* リアルタイム震度データの観測時刻。以前はリアルタイムタブでのみ表示して
          いたが、全タブ共通(設定タブ含む)で常時表示するように変更した。
          地震・津波・潮位観測点のいずれかを選択して詳細を見ている間は、
          地図上の推計震度分布自体を隠す(showRealtimeMapLayers)ため、
          時刻表示も合わせて隠す。緊急地震速報の詳細表示中は
          showRealtimeMapLayers側で隠さなくなったため、ここでも
          eewDetailOpenでは隠さない。
          フローティングパネルの兄弟要素として外に出し、他の戻るボタン等と
          同じ考え方でフローティングの動きに追従させる。
          広い画面(isWide)では、パネルの高さ変化(レイヤーパネルの開閉など)には
          追従させず、画面下端に固定する。左位置は、サイドナブレール+パネルの
          共有ガラス(App側でtop:16〜bottom:16の全高固定)の外(右側=地図側)に
          出すため、wideAnchorRect.right基準にする(wideAnchorRect.leftだと
          水平方向はガラスの内側に収まってしまい、フローティングの中に
          埋もれて見えるため)。狭い画面(縦持ち)では、他の戻るボタンと
          同様にcurrentHeight基準でパネル上端付近に追従させる。
          地震検知テスト(実験的機能)実行中は、ShakeTestRunningBadgeを
          RealtimeDataTimeBadgeの直上に小さく重ねて表示する(flex column
          で積み上げ、bottomのみ指定することでコンテナが上方向に伸びる
          形にしている)。 */}
      {selectedQuakeId == null && selectedTsunamiId == null
        && selectedTideStationCode == null && realtimeDataTime && (
        isWide && wideAnchorRect ? createPortal(
          <div style={{
            position: "fixed",
            left: wideAnchorRect.right + 12,
            bottom: 16,
            zIndex: 50,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 6,
          }}>
            {shakeTests && shakeTests.length > 0 && (
              <ShakeTestRunningBadge
                count={shakeTests.length}
                onStop={() => onShakeTestAction?.("stop")}
              />
            )}
            <RealtimeDataTimeBadge dataTime={realtimeDataTime}/>
          </div>,
          document.body
        ) : (
        <div style={{
          position: "absolute",
          left: 14,
          bottom: currentHeight + NAV_ROW_HEIGHT + 8,
          transition: isDragging ? "none" : "bottom 0.4s cubic-bezier(.22,1,.36,1)",
          zIndex: 10,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 6,
        }}>
          {shakeTests && shakeTests.length > 0 && (
            <ShakeTestRunningBadge
              count={shakeTests.length}
              onStop={() => onShakeTestAction?.("stop")}
            />
          )}
          <RealtimeDataTimeBadge dataTime={realtimeDataTime}/>
        </div>
        )
      )}

      {(() => {
        const GlassOrPlain = isWide ? "div" : Glass;
        const glassProps = isWide
          ? { ref: wideContentRef, "data-floating-panel": "dock", style: { width: "clamp(240px, 30vw, 380px)", height: "100%", overflow: "hidden", position: "relative" } }
          : {
              "data-floating-panel": "dock", // 視点移動(mapFocus.js)が、フローティングに隠れる範囲を実測するための目印
              filterSize: settled ? "normal" : "none",
              blur: settled ? 14 : 8,
              style: {
                width: "100%",
                maxWidth: 480,
                minWidth: 240,
                borderRadius: `${topRadius}px ${topRadius}px ${bottomRadius}px ${bottomRadius}px`,
                transition: isDragging ? "none" : "border-radius 0.4s cubic-bezier(.22,1,.36,1)",
                overflow: "hidden",
                animation: "appear 0.4s cubic-bezier(.25,1,.5,1) 0.1s both",
              },
            };
        return (
      <GlassOrPlain {...glassProps}>
      {/* uiScaleが1未満の時(横画面で画面が低い場合)、中身を実際より広い
          仮想サイズでレイアウトさせてから縮小することで、外枠(Glassの箱)の
          サイズは変えずに文字・要素だけを縮めて収める。
          uiScale===1(縦画面、または横画面でも画面が十分高い場合)では、
          たとえscale(1)であってもtransformを祖先要素に付けると、
          スクロール関連の挙動(iOS Safariでのタッチスクロール、
          scrollIntoViewによる自動スクロール位置など)がおかしくなる
          ことがあるため、実際に縮小が必要な時だけこのラッパーを使う
          (それ以外はFragmentで素通しする)。 */}
      {(() => {
        const needsScale = uiScale < 1;
        const ScaleWrap = needsScale ? "div" : Fragment;
        const scaleWrapProps = needsScale ? {
          style: {
            width: `${100 / uiScale}%`,
            height: `${100 / uiScale}%`,
            transform: `scale(${uiScale})`,
            transformOrigin: "top left",
          },
        } : {};
        return (
      <ScaleWrap {...scaleWrapProps}>
      {/* レイヤーパネル部分 — 高さを直接アニメーションし、
          ナビバーのガラスの中から「せり出してくる」ように展開する。
          広い画面(isWide)では、ドラッグで高さを変える仕組み自体を使わず、
          常に親いっぱいの固定高さで表示する。 */}
      <div
        aria-hidden={!isWide && snapIndex === 0 && !isDragging}
        style={{
          position: "relative",
          height: isWide ? "100%" : currentHeight,
          paddingTop: isWide ? 14 : 0, // ハンドルが無い分、上に少し余白を持たせる
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          transition: isWide || isDragging ? "none" : "height 0.4s cubic-bezier(.22,1,.36,1)",
          pointerEvents: isWide || snapIndex > 0 || isDragging ? "auto" : "none",
        }}
      >
        {/* ドラッグハンドル — 広い画面(isWide)では高さを変える操作自体が無いため
            表示しない。狭い画面(縦持ち)でのみ、常に上部に固定表示する。
            以前は当たり判定を absolute で上下に張り出す構成にしていたが、
            重ね合わせが原因と思われる表示崩れが発生したため、
            ハンドル行自体の高さを広げてタップ範囲とするシンプルな
            構成に戻した(見た目のバー位置は中央のまま変わらない)。 */}
        {!isWide && (
        <div
          onPointerDown={handlePointerDown}
          style={{
            flexShrink: 0,
            display: "flex", justifyContent: "center", alignItems: "center",
            width: "100%", height: HANDLE_HEIGHT,
            background: "transparent",
            cursor: "grab",
            touchAction: "none", userSelect: "none",
          }}
        >
          <div style={{
            width: 36, height: 4, borderRadius: 999,
            background: `rgba(${tokens.ink},0.45)`,
          }}/>
        </div>
        )}

        {/* 地震タブの「一覧⇄検索」切り替えバー — ハンドル直下に固定表示し、
            スクロールしても本体と一緒には動かない(検索/一覧の入口を常に見せておく)。
            地震を選択してカード表示になっている間、および緊急地震速報の詳細を
            表示している間は不要なので隠す。 */}
        {!eewDetailOpen && active === "quake" && selectedQuakeId == null && (
          <QuakeListToolbar
            mode={quakeViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setQuakeViewMode(mode); }}
            onHandoffToPanelDrag={handlePointerDown}
          />
        )}

        {/* 津波タブの「一覧⇄過去」切り替えバー — 地震タブと全く同じ考え方。
            津波情報を選択してカード表示になっている間、または(モードを切り替えずに
            その場で表示している)潮位観測点の詳細を表示している間、および緊急地震速報の
            詳細を表示している間は不要なので隠す。 */}
        {!eewDetailOpen && active === "tsunami" && selectedTsunamiId == null && selectedTideStationCode == null && (
          <QuakeListToolbar
            items={TSUNAMI_TOOLBAR_ITEMS}
            mode={tsunamiViewMode}
            onModeChange={(mode) => { killScrollMomentum(); setTsunamiViewMode(mode); }}
            onHandoffToPanelDrag={handlePointerDown}
          />
        )}

        {/* スクロール可能な本体 — ヘッダー・レイヤー一覧だけがここでスクロールする。
            overflowAnchor: "none" は、タブ切り替えで中身の高さが変わった際に
            ブラウザのスクロールアンカリングがスクロール位置を勝手にずらし、
            ヘッダーや先頭行が隠れて見える不具合を防ぐため。
            key で active/quakeViewMode ごとに別のDOM要素にしているのは、
            scrollTop=0を後から代入するだけだと、iOSの慣性スクロール(勢いよく
            フリックした後の減速アニメーション)が同じ要素に対して裏側で動き続け、
            切り替え直後にリセットしてもすぐ上書きされて別タブ側まで動いてしまう
            ため。要素ごと作り直すことで、古い要素に紐づく慣性スクロールを
            物理的に断ち切る。
            eewDetailOpenもkeyに含めているのは、これが無いと「今見ているタブ」の
            スクロールコンテナをそのまま緊急地震速報の表示にも使い回してしまい、
            EEWを開く前/後でスクロール位置が引き継がれてしまう(EEWを見ている間に
            スクロールすると、閉じた時にタブ本来の内容側もそのスクロール位置に
            なってしまう)ため。リアルタイムタブの「タップ不要でそのままEEWを表示」
            (active === "realtime" && hasActiveEew)も同じ理由でkeyに含める。 */}
        <div
          key={`${eewDetailOpen || (active === "realtime" && hasActiveEew)}:${active}:${quakeViewMode}:${tsunamiViewMode}:${selectedQuakeId != null}:${selectedTsunamiId != null}:${selectedTideStationCode != null}`}
          ref={scrollRef}
          style={{
            flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden", overflowAnchor: "none",
            // 文字(数字含む)の上を指でなぞった時、iOS Safariは既定だと
            // テキスト選択ジェスチャーとして扱ってしまい、スクロールが
            // 効かなくなることがある。中身のテキストを選択不可にして、
            // どこを触ってもスクロールとして扱われるようにする。
            userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none",
          }}
        >
          <div>
            {eewDetailOpen && active !== "realtime" ? (
              <>
                {/* 緊急地震速報の詳細 — 地震タブでQuakeDetailCard/QuakeMessageCardが
                    並ぶのと全く同じように、囲みなしでカードを直接並べる。タブの中身を
                    一時的に置き換えるだけで、閉じれば元のタブ表示にそのまま戻る。
                    地震カード・津波カードと違い、カード全体ではなく「緊急地震速報
                    (警報/予報)」ブロックと「第◯報」ブロック(見出し部分)だけを
                    PanelDragHandoffCardで包む(EewDetailFloatingCard内部で対応)。
                    最大予測震度カードなど、それ以外の部分をドラッグしてもパネルの
                    高さは変わらないようにするため。
                    リアルタイムタブは、ここではなく最後のelse分岐(active===realtime)
                    側で、緊急地震速報カードと通常のタブ内容(直近の地震一覧/詳細)を
                    上下に並べて両方表示するようにしているため、ここでは対象外にする。 */}
                {eews.map(eew => (
                  <EewDetailFloatingCard key={eew.eventId} eew={eew} onHandoffToPanelDrag={handlePointerDown}/>
                ))}
              </>
            ) : active === "quake" ? (
              <>
                {quakeViewMode !== "search" && quakeStatus === "loading" && quakes.length === 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    gap: 8, padding: "18px 0", color: `rgba(${tokens.ink},0.45)`,
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%",
                      border: `2px solid rgba(${tokens.ink},0.15)`,
                      borderTopColor: `rgba(${tokens.ink},0.6)`,
                      animation: "spin 0.8s linear infinite",
                    }}/>
                    <span style={{ fontSize: 12 }}>地震情報を取得中…</span>
                  </div>
                )}

                {quakeViewMode !== "search" && quakeStatus === "error" && quakes.length === 0 && (
                  <div style={{ padding: "18px 16px", textAlign: "center" }}>
                    <span style={{ fontSize: 12, color: "rgba(255,140,140,0.9)" }}>
                      地震情報の取得に失敗しました
                    </span>
                  </div>
                )}

                {(() => {
                  // 選択中の地震は、直近一覧(quakes)だけでなく、気象庁 震度データベース検索
                  // から開いた地震(searchQuake)も対象に探す(検索結果はquakesには入れていないため)。
                  const selected = quakes.find(q => q.id === selectedQuakeId)
                    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

                  // 選択中は「カード(+各地の震度)のみ」、未選択は「一覧のみ」の排他表示。
                  if (selected) {
                    if (nearbyQuakeFor) {
                      return (
                        <div key={`${selected.id}:nearby`}>
                          <NearbyQuakesPanel
                            place={nearbyQuakeFor}
                            stations={stations}
                            colorScheme={colorScheme}
                            onFoundQuake={onFoundSearchQuake}
                            onPointsChange={setNearbyEpicenterPoints}
                            onLoadingChange={setNearbyEpicenterLoading}
                            epicenterCirclesEnabled={epicenterCirclesEnabled}
                            onSelectQuake={(id) => {
                              if (scrollRef.current) nearbyListScrollTopRef.current = scrollRef.current.scrollTop;
                              setNearbyQuakeFor(null);
                              handleSelectQuakeForScroll(id);
                            }}
                          />
                        </div>
                      );
                    }
                    if (mechDetailOpen) {
                      return (
                        <div key={`${selected.id}:mech`}>
                          <QuakeMechDetailPanel quake={selected}/>
                        </div>
                      );
                    }
                    return (
                      <div key={selected.id}>
                        <PanelDragHandoffCard onHandoffToPanelDrag={handlePointerDown}>
                          <QuakeDetailCard quake={selected}/>
                        </PanelDragHandoffCard>
                        {!selected.isEqdb && <QuakeMessageCard quake={selected}/>}
                        {shouldShowNearbyQuakeButton(selected) && (
                          <div style={{ margin: "2px 14px 8px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setNearbyOriginId(selected.id);
                                setNearbyQuakeFor(selected.place);
                                setSnapIndex(3);
                              }}
                              style={{
                                width: "100%", padding: "10px 12px", borderRadius: 12,
                                border: "none", cursor: "pointer",
                                background: `rgba(${tokens.ink},0.08)`,
                                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                                color: tokens.text, fontSize: 13, fontWeight: 600,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              }}
                            >
                              この震源の近傍で発生した地震
                            </PressableButton>
                          </div>
                        )}
                        {stationPoints.length > 0 && (
                          <StationPointsList points={stationPoints} displayMode={stationListDisplayMode}
                            openKey={stationDetailOpenKey} onOpenKeyChange={setStationDetailOpenKey}/>
                        )}
                        {/* 発震機構解はおおむねM5.0以上でないと気象庁側で解析されないため、
                            それ未満の地震ではボタン自体を出さない。 */}
                        {selected.magnitude != null && selected.magnitude >= 5.0 && (
                          <div style={{ margin: "8px 14px 4px" }}>
                            <PressableButton
                              type="button"
                              onClick={() => {
                                if (scrollRef.current) scrollRef.current.scrollTop = 0;
                                setMechDetailOpen(true);
                                setSnapIndex(3);
                              }}
                              style={{
                                width: "100%", padding: "10px 12px", borderRadius: 12,
                                border: "none", cursor: "pointer",
                                background: `rgba(${tokens.ink},0.08)`,
                                boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                                color: tokens.text, fontSize: 13, fontWeight: 600,
                                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                              }}
                            >
                              この地震の詳細
                            </PressableButton>
                          </div>
                        )}
                      </div>
                    );
                  }

                  // 「検索」モード: 気象庁 震度データベース(eqdb)を期間・M・最大震度で検索するUI。
                  if (quakeViewMode === "search") {
                    return (
                      <QuakeSearchPanel
                        stations={stations}
                        colorScheme={colorScheme}
                        onFoundQuake={onFoundSearchQuake}
                        onSelectQuake={handleSelectQuakeForScroll}
                        search={eqdbSearch}
                        onChangeSearch={setEqdbSearch}
                        onSearchExecuted={() => setSnapIndex(3)}
                        scrollContainerRef={scrollRef}
                        onPointsChange={setSearchEpicenterPoints}
                        onLoadingChange={setSearchEpicenterLoading}
                        epicenterCirclesEnabled={epicenterCirclesEnabled}
                      />
                    );
                  }

                  return (
                    <>
                      {quakes.map((q, i) => (
                        <QuakeListRow
                          key={q.id}
                          quake={q}
                          showDivider={i > 0}
                          colorScheme={colorScheme}
                          onSelect={() => handleSelectQuakeForScroll(q.id)}
                        />
                      ))}
                    </>
                  );
                })()}

                {/* フローティング部分(地震一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "tsunami" ? (
              <>
                <TsunamiTabBody
                  tsunamis={tsunamis}
                  status={tsunamiStatus}
                  selectedId={selectedTsunamiId}
                  onSelect={handleSelectTsunamiForScroll}
                  onHandoffToPanelDrag={handlePointerDown}
                  viewMode={tsunamiViewMode}
                  historyItems={tsunamiHistory?.items ?? EMPTY_EQDB_LIST}
                  historyStatus={tsunamiHistory?.status ?? "idle"}
                  historyHasMore={tsunamiHistory?.hasMore ?? true}
                  historyDebug={tsunamiHistory?.debug ?? ""}
                  onLoadMoreHistory={onLoadMoreTsunamiHistory}
                  onFindCausingQuake={handleFindCausingQuake}
                  causingQuakeState={causingQuakeState}
                  showingCausingQuakeFor={showingCausingQuakeFor}
                  onBackFromCausingQuake={handleBackFromCausingQuake}
                  stationListDisplayMode={stationListDisplayMode}
                  causingQuakeStationOpenKey={causingQuakeStationOpenKey}
                  onChangeCausingQuakeStationOpenKey={setCausingQuakeStationOpenKey}
                  tideStations={tideStations}
                  tideStationsStatus={tideStationsStatus}
                  selectedTideStationCode={selectedTideStationCode}
                  onSelectTideStation={onSelectTideStation}
                  tideObsByStation={tideObsByStation}
                  onLoadTideObs={onLoadTideObs}
                  tsunamiHeightByStation={tsunamiHeightByStation}
                  tsunamiHeightTimeByStation={tsunamiHeightTimeByStation}
                />

                {/* フローティング部分(津波情報一覧)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : active === "settings" ? (
              <>
                <SettingsBody
                  path={settingsPath}
                  onNavigate={handleSettingsNavigate}
                  colorSchemeId={colorSchemeId}
                  onChangeColorScheme={onChangeQuakeColorScheme}
                  estIntensityEnabled={estIntensityEnabled}
                  onChangeEstIntensityEnabled={onChangeEstIntensityEnabled}
                  areaFillEnabled={areaFillEnabled}
                  onChangeAreaFillEnabled={onChangeAreaFillEnabled}
                  faultsEnabled={faultsEnabled}
                  onChangeFaultsEnabled={onChangeFaultsEnabled}
                  plateBoundariesEnabled={plateBoundariesEnabled}
                  onChangePlateBoundariesEnabled={onChangePlateBoundariesEnabled}
                  epicenterCirclesEnabled={epicenterCirclesEnabled}
                  onChangeEpicenterCirclesEnabled={onChangeEpicenterCirclesEnabled}
                  boundaryLineColorId={boundaryLineColorId}
                  onChangeBoundaryLineColorId={onChangeBoundaryLineColorId}
                  quakeFetchLimit={quakeFetchLimit}
                  onChangeQuakeFetchLimit={onChangeQuakeFetchLimit}
                  stationListDisplayMode={stationListDisplayMode}
                  onChangeStationListDisplayMode={onChangeStationListDisplayMode}
                  experimentalFeaturesEnabled={experimentalFeaturesEnabled}
                  onChangeExperimentalFeaturesEnabled={onChangeExperimentalFeaturesEnabled}
                  /* realtimeApiToken={realtimeApiToken} */
                  replayPlayer={replayPlayer}
                  /* onChangeRealtimeApiToken={onChangeRealtimeApiToken} */
                  realtimeRisingEnabled={realtimeRisingEnabled}
                  onChangeRealtimeRisingEnabled={onChangeRealtimeRisingEnabled}
                  replayJmaColorEnabled={replayJmaColorEnabled}
                  onChangeReplayJmaColorEnabled={onChangeReplayJmaColorEnabled}
                  shakeDetectionEnabled={shakeDetectionEnabled}
                  onChangeShakeDetectionEnabled={onChangeShakeDetectionEnabled}
                  epicenterEstimationEnabled={epicenterEstimationEnabled}
                  onChangeEpicenterEstimationEnabled={onChangeEpicenterEstimationEnabled}
                  testTsunami={testTsunami}
                  onBroadcastTestTsunami={onBroadcastTestTsunami}
                  onCancelTestTsunami={onCancelTestTsunami}
                  onClearTestTsunami={onClearTestTsunami}
                  testEews={testEews}
                  onTestEewAction={onTestEewAction}
                  eewTestForm={eewTestForm}
                  eewEpicenterPickActive={eewEpicenterPickActive}
                  testQuake={testQuake}
                  onTestQuakeAction={onTestQuakeAction}
                  quakeTestForm={quakeTestForm}
                  quakeEpicenterPickActive={quakeEpicenterPickActive}
                  quakeTestAutoPlaying={quakeTestAutoPlaying}
                  shakeTests={shakeTests}
                  onShakeTestAction={onShakeTestAction}
                  shakeTestForm={shakeTestForm}
                  shakeTestEpicenterPickActive={shakeTestEpicenterPickActive}
                  epicenterEstimates={epicenterEstimates}
                  tsunamiAreaPickActive={tsunamiAreaPickActive}
                  onStartTsunamiAreaPick={onStartTsunamiAreaPick}
                  pickedTsunamiAreas={pickedTsunamiAreas}
                  onRemoveTsunamiAreaPick={onRemoveTsunamiAreaPick}
                  onCycleTsunamiAreaGrade={onCycleTsunamiAreaGrade}
                  pickedTsunamiHeights={pickedTsunamiHeights}
                  onChangeTsunamiHeightPick={onChangeTsunamiHeightPick}
                  onRemoveTsunamiHeightPick={onRemoveTsunamiHeightPick}
                  candidateHeightStations={candidateHeightStations}
                  onAddTsunamiHeightPick={onAddTsunamiHeightPick}
                />

                {/* フローティング部分(設定メニュー)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            ) : (
              <>
                {/* 緊急地震速報が発生している間は、リアルタイムタブのフローティング
                    の1番上に緊急地震速報カードを表示する(地図側の予想震度凡例と
                    同じ考え方)。ただし他タブと違い、平常時の内容(直近の地震一覧/
                    詳細)を隠して置き換えるのではなく、その下に続けて表示する。 */}
                {hasActiveEew && eews.map(eew => (
                  <EewDetailFloatingCard key={eew.eventId} eew={eew} onHandoffToPanelDrag={handlePointerDown}/>
                ))}
                {/* 揺れ検知エンジンが検出したイベント(確定分のみ)。緊急地震速報の
                    下・平常時の内容の上に並べる。未確定のものは地図上のみで示し、
                    このリストにはノイズを避けるため出さない。 */}
                {shakeEvents.filter(e => e.confirmed).map(e => (
                  <ShakeEventCard key={e.id} event={e}/>
                ))}
                {selectedQuakeId != null ? (() => {
                  // リアルタイムタブの「直近の地震一覧」から選んだ場合も、地震タブと
                  // 全く同じ詳細表示(近傍地震一覧・発震機構解パネルを含む)にする。
                  const selected = quakes.find(q => q.id === selectedQuakeId)
                    || (searchQuake && searchQuake.id === selectedQuakeId ? searchQuake : null);

                  if (!selected) return null;

                  if (nearbyQuakeFor) {
                    return (
                      <div key={`${selected.id}:nearby`}>
                        <NearbyQuakesPanel
                          place={nearbyQuakeFor}
                          stations={stations}
                          colorScheme={colorScheme}
                          onFoundQuake={onFoundSearchQuake}
                          onPointsChange={setNearbyEpicenterPoints}
                          onLoadingChange={setNearbyEpicenterLoading}
                          epicenterCirclesEnabled={epicenterCirclesEnabled}
                          onSelectQuake={(id) => {
                            if (scrollRef.current) nearbyListScrollTopRef.current = scrollRef.current.scrollTop;
                            setNearbyQuakeFor(null);
                            handleSelectQuakeForScroll(id);
                          }}
                        />
                      </div>
                    );
                  }
                  if (mechDetailOpen) {
                    return (
                      <div key={`${selected.id}:mech`}>
                        <QuakeMechDetailPanel quake={selected}/>
                      </div>
                    );
                  }
                  return (
                    <div key={selected.id}>
                      <PanelDragHandoffCard onHandoffToPanelDrag={handlePointerDown}>
                        <QuakeDetailCard quake={selected}/>
                      </PanelDragHandoffCard>
                      {!selected.isEqdb && <QuakeMessageCard quake={selected}/>}
                      {shouldShowNearbyQuakeButton(selected) && (
                        <div style={{ margin: "2px 14px 8px" }}>
                          <PressableButton
                            type="button"
                            onClick={() => {
                              if (scrollRef.current) scrollRef.current.scrollTop = 0;
                              setNearbyOriginId(selected.id);
                              setNearbyQuakeFor(selected.place);
                              setSnapIndex(3);
                            }}
                            style={{
                              width: "100%", padding: "10px 12px", borderRadius: 12,
                              border: "none", cursor: "pointer",
                              background: `rgba(${tokens.ink},0.08)`,
                              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                              color: tokens.text, fontSize: 13, fontWeight: 600,
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            }}
                          >
                            この震源の近傍で発生した地震
                          </PressableButton>
                        </div>
                      )}
                      {stationPoints.length > 0 && (
                        <StationPointsList points={stationPoints} displayMode={stationListDisplayMode}
                          openKey={stationDetailOpenKey} onOpenKeyChange={setStationDetailOpenKey}/>
                      )}
                      {/* 発震機構解はおおむねM5.0以上でないと気象庁側で解析されないため、
                          それ未満の地震ではボタン自体を出さない。 */}
                      {selected.magnitude != null && selected.magnitude >= 5.0 && (
                        <div style={{ margin: "8px 14px 4px" }}>
                          <PressableButton
                            type="button"
                            onClick={() => {
                              if (scrollRef.current) scrollRef.current.scrollTop = 0;
                              setMechDetailOpen(true);
                              setSnapIndex(3);
                            }}
                            style={{
                              width: "100%", padding: "10px 12px", borderRadius: 12,
                              border: "none", cursor: "pointer",
                              background: `rgba(${tokens.ink},0.08)`,
                              boxShadow: `inset 0 0 0 0.5px rgba(${tokens.ink},0.14)`,
                              color: tokens.text, fontSize: 13, fontWeight: 600,
                              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                            }}
                          >
                            この地震の詳細
                          </PressableButton>
                        </div>
                      )}
                    </div>
                  );
                })() : (
                  <div style={{ margin: "8px 6px" }}>
                    <div style={{
                      fontSize: 12, fontWeight: 700,
                      color: `rgba(${tokens.ink},0.5)`,
                      padding: "0 6px 6px",
                    }}>
                      直近で発生した地震
                    </div>
                    <Glass radius={14} style={{ overflow: "hidden" }}>
                      {quakes.slice(0, 5).map((q, i) => (
                        <QuakeListRow
                          key={q.id}
                          quake={q}
                          showDivider={i > 0}
                          colorScheme={colorScheme}
                          onSelect={() => handleSelectQuakeForScroll(q.id)}
                          horizontalPadding={8}
                        />
                      ))}
                    </Glass>
                  </div>
                )}

                {/* フローティング部分(直近の地震一覧/詳細)とボタン類(ナビ行)の境界線 */}
                <div style={{ height: 0.5, background: `rgba(${tokens.ink},0.22)`, margin: "2px 0 0" }}/>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ナビ行 — 常に表示される、ガラスの“足元”。
          Liquid Glassのハイライトが指の位置に連続追従し、なぞるだけで
          タブを選べる。タップのみの操作もそのまま機能する。
          広い画面(isWide)では、代わりに左端のSideNavRailを使うのでここでは出さない。 */}
      {!isWide && (
      <div
        ref={navRowRef}
        onPointerDown={handleNavPointerDown}
        onPointerMove={handleNavPointerMove}
        onPointerUp={handleNavPointerUp}
        onPointerCancel={handleNavPointerUp}
        style={{
          position: "relative",
          display: "flex", flexDirection: "row",
          padding: `4px ${NAV_PAD_X}px`, gap: 0,
          touchAction: "none",
          userSelect: "none",
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",     // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
          WebkitTapHighlightColor: "transparent",
        }}
      >
        {/* ガラスのハイライトピル — %ベースで位置・幅を管理。
            ドラッグ中: transition:none で指に即座追従。
            pointerup 後: spring transition でスナップ位置へ吸い付く。 */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            top: 4, bottom: 4,
            // 親(ナビ行)基準の % だけだと外側パディングが二重に効かず
            // ハイライトが外枠の縁に接してしまうため、calc() で
            // 内側領域オフセット(NAV_PAD_X)を明示的に加算する。
            left: `calc(${NAV_PAD_X}px + (100% - ${NAV_PAD_X * 2}px) * ${highlightLeft / 100})`,
            width: `calc((100% - ${NAV_PAD_X * 2}px) * ${tabW / 100})`,
            borderRadius: 999,
            background: (navPressed || navDragging) && !glassOpaque ? tokens.glassTint : tokens.navPillBg,
            boxShadow: (navPressed || navDragging) && !glassOpaque
              ? `inset 0 0 0 0.5px ${tokens.rimLight}, inset 0 1px 0 ${tokens.rimHighlight}`
              : tokens.navPillShadow,
            // タッチ/ドラッグ中だけ本物のガラス(backdrop-filter blur)にする。
            backdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
            WebkitBackdropFilter: (navPressed || navDragging) && !glassOpaque ? touchGlassBackdropFilter(mode) : "none",
            // 押している間はわずかに拡大し、Apple Liquid Glass特有の
            // "押し込むとガラスが少し膨らむ" 触覚的な質感を再現する。
            transform: navPressed ? "scale(1.16)" : "scale(1)",
            transformOrigin: "center",
            transition: navDragging
              ? "transform 0.18s cubic-bezier(.22,1,.36,1)"
              : "left 0.38s cubic-bezier(.22,1,.36,1), transform 0.18s cubic-bezier(.22,1,.36,1)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />

        {NAV.map(({ id, label }, idx) => {
          const isActive = idx === displayIdx;
          return (
            <button
              key={id}
              onClick={() => handleNavClick(id)}
              style={{
                position: "relative", zIndex: 1,
                display: "flex", flexDirection: "column",
                alignItems: "center", justifyContent: "center",
                gap: 4, flex: 1, minWidth: 0, height: 58,
                borderRadius: 999, border: "none",
                background: "transparent",
                cursor: "pointer",
                color: isActive ? `rgba(${tokens.ink},1)` : `rgba(${tokens.ink},0.6)`,
                transition: "color 0.15s",
                padding: "0 4px",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",   // iOS: 長押しでのコピー/調べる/翻訳メニューを無効化
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {NAV_ICONS[id]}
              <span style={{
                fontSize: 11,
                fontWeight: isActive ? 700 : 500,
                lineHeight: 1,
                letterSpacing: -0.1,
                whiteSpace: "nowrap",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
              }}>
                {label}
              </span>
            </button>
          );
        })}
      </div>
      )}
      </ScaleWrap>
        );
      })()}
      </GlassOrPlain>
        );
      })()}
    </>
  );
}
