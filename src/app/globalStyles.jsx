import { THEME_TOKENS } from "./theme";


/* ─────────────────────────────────────────────────────
   GLOBAL STYLES
   ───────────────────────────────────────────────────── */
export function GlobalStyles({ tokens = THEME_TOKENS.dark }) {
  return (
    <style>{`
      :root {
        --page-bg: ${tokens.pageBg};
        --text: ${tokens.text};
        --glass-opaque-bg: ${tokens.glassOpaqueBg};
      }
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      /* PC(Windows/Mac)のChrome・Edgeでは、地震一覧などスクロール可能な
         パネル内に、ネイティブの太い白っぽいスクロールバーがそのまま
         出てしまい、Liquid Glassの見た目にそぐわない。スクロール自体は
         有効なまま、バーの見た目だけ全要素で非表示にする。 */
      *, *::before, *::after {
        scrollbar-width: none;      /* Firefox */
        -ms-overflow-style: none;   /* 旧Edge/IE */
      }
      *::-webkit-scrollbar {
        display: none;              /* Chrome, 新Edge, Safari */
        width: 0;
        height: 0;
      }
      html, body, #root { height: 100%; width: 100%; }
      /* iOSのスタンドアロンPWAは、ステータスバー分(env(safe-area-inset-top))だけ
         ドキュメント全体を上にずらして描画するが、高さ自体は増えないため、
         その分だけ下端に隙間ができてしまう。ずらされる分だけ高さを余分に
         確保しておくことで、この隙間を無くす。 */
      html { min-height: calc(100% + env(safe-area-inset-top, 0px)); }
      html {
        overflow: hidden;
        background: var(--page-bg);
      }
      body {
        /*
          position:fixed でページ自体を完全に固定する。
          iOSのSafariは、地図をドラッグした際に地図だけでなく
          ページ全体がわずかに弾性スクロール(ラバーバンド)してしまうことがあり、
          その一瞬だけSafariのデフォルトのUI背景(白)が画面端に見えてしまう。
          overscroll-behavior だけでは防ぎきれないため、position:fixedで
          ページ自体をスクロール不可能な状態に固定して根本的に防ぐ。
        */
        position: fixed;
        inset: 0;
        background: var(--page-bg);
        font-family: -apple-system, BlinkMacSystemFont,
                     "SF Pro Display", "Helvetica Neue",
                     "Noto Sans JP", sans-serif;
        -webkit-font-smoothing: antialiased;
        overflow: hidden;
        overscroll-behavior: none;
        touch-action: none;
        color: var(--text);
      }
      /* アプリ全体をネイティブアプリのUIのように扱うため、長押しでの
         テキスト選択・コピー/調べる/翻訳メニュー(iOSのcallout)を無効化する。
         フローティングパネルや震度凡例を長押しした時に、意図せず選択
         ハイライトやコピーメニューが出てしまうのを防ぐ。 */
      *, *::before, *::after {
        -webkit-user-select: none;
        user-select: none;
        -webkit-touch-callout: none;
        -webkit-tap-highlight-color: transparent;
      }
      #root {
        position: absolute;
        inset: 0;
        overflow: hidden;
      }
      button { font-family: inherit; background: none; border: none; cursor: pointer; }

      /* Liquid Glassの背景は backdrop-filter の blur ありきで
         rgba(255,255,255,0.02) というほぼ完全に透明な色にしている。
         backdrop-filter に対応していない環境(一部のAndroid端末やPC)では、
         ぼかしが一切効かず、ほぼ透明な色だけが残るため、パネルが
         「完全に透けて見える」状態になってしまう。
         backdrop-filterが使えない場合だけ、はっきり見える不透明めの
         背景色に差し替える(!importantはこのフォールバック目的でのみ使用)。 */
      @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        .glass-backdrop-layer {
          background: var(--glass-opaque-bg) !important;
        }
      }

      @keyframes pulse {
        0%,100% { opacity:1; transform:scale(1); box-shadow: 0 0 0 0 currentColor; }
        50%      { opacity:0.4; transform:scale(0.55); }
      }
      @keyframes appear {
        from { opacity:0; transform:translateY(10px) scale(0.97); }
        to   { opacity:1; transform:translateY(0)    scale(1); }
      }
      @keyframes eewFabPulse {
        0%,100% { box-shadow: 0 0 0 0 rgba(255,69,58,0.5); }
        50%      { box-shadow: 0 0 0 8px rgba(255,69,58,0); }
      }
      /* レイヤーパネルはキーフレームではなく transform/opacity の
         トランジションで開閉する（下部アイコンバーへ向けて滑らかに
         スライスイン・アウトできるよう、常時マウントして状態だけ切替える） */
      @keyframes fadeIn {
        from { opacity:0; }
        to   { opacity:1; }
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      /* MapLibreの標準UIはLiquid Glassの自前コントロールに置き換えるため非表示 */
      .maplibregl-ctrl-top-right,
      .maplibregl-ctrl-top-left,
      .maplibregl-ctrl-bottom-left,
      .maplibregl-ctrl-bottom-right,
      .maplibregl-control-container { display: none; }

      .mono { font-variant-numeric: tabular-nums; }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: 0.01ms !important;
          transition-duration: 0.01ms !important;
        }
      }
    `}</style>
  );
}
