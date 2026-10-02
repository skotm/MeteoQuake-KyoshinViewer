import { useContext } from "react";
import { ThemeContext } from "./theme";
import { PressableButton } from "./glass";
import { Toggle } from "./navUi";


/* ─────────────────────────────────────────────────────
   SETTINGS TAB — 階層メニュー
   設定タブを開くとまずカテゴリ一覧(地震/津波/気象/警報/詳細設定)を表示し、
   カテゴリを選ぶとその中の項目一覧へ、項目を選ぶと実際の設定内容へ、と
   BottomDockパネルの中身をその場で差し替えながら掘り下げていく構成。
   現在地は親(BottomDock)がsettingsPath(配列)として持ち、このコンポーネントは
   それを受け取って該当する画面を描くだけの純粋な表示コンポーネントにしている。

   見た目は「地図レイヤー」一覧(フチなし全幅リスト+下線ヘッダー)をそのまま
   流用せず、震度配色ピッカーで元々使っていた「角丸のグループ化カード」を
   基本デザインとして統一している。
   ───────────────────────────────────────────────────── */
// 設定トップの一覧。「利用規約等・注意事項」(ライセンスもこの中に含む)は
// 詳細設定の下ではなくトップ階層に置く。
export const SETTINGS_MENU = [
  { id: "tabSettings", label: "タブ設定" },
  { id: "terms",       label: "利用規約等・注意事項" },
  { id: "advanced",    label: "詳細設定" },
];

// 「タブ設定」配下の一覧。以前のSETTINGS_MENUそのもの。
// pathとしては ["tabSettings", "quake", ...] のように先頭にtabSettingsが付く形になる。
export const TAB_SETTINGS_CATEGORIES = [
  { id: "quake",    label: "地震" },
  { id: "tsunami",  label: "津波" },
  { id: "realtime", label: "リアルタイム" },
];

// カテゴリごとの項目一覧。地震・利用規約等の各カテゴリはSettingsBody内で専用に
// 組み立てるためここには含めない。他のカテゴリは現状すべて骨組み(空のプレースホルダー画面)。
export const SETTINGS_ITEMS = {
  advanced: [
    { id: "appearance", label: "外観" },
    // 【廃止】APIトークン入力機能を廃止したため、設定メニューからも除外。
    // { id: "realtimeApi", label: "リアルタイムAPI" },
    { id: "replay", label: "リプレイ" },
    { id: "experimental", label: "実験的・テスト機能" },
    { id: "logs", label: "ログ" },
  ],
};

// 設定画面共通のヘッダー。「地図レイヤー」のような下線区切りは使わず、
// 太字の大きめタイトルにすることで独自の見た目にしている。
// 戻る操作は地震タブと同じ丸いフローティングボタン(BackToListButton)に
// 統一したので、ヘッダー自体には戻るボタンを持たせていない。
export function SettingsHeader({ title }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ padding: "12px 14px 6px" }}>
      <span style={{ fontSize: 16, fontWeight: 700, color: tokens.text }}>
        {title}
      </span>
    </div>
  );
}

// カテゴリ/項目一覧を包む角丸のグループ化カード。震度配色ピッカーと同じ見た目の箱。
export function SettingsCard({ children }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{ margin: "6px 14px 8px" }}>
      <div style={{
        borderRadius: 12,
        overflow: "hidden",
        background: tokens.cardBg,
        boxShadow: `inset 0 0 0 0.5px ${tokens.cardBorder}`,
      }}>
        {children}
      </div>
    </div>
  );
}

export function SettingsCardDivider() {
  const { tokens } = useContext(ThemeContext);
  return <div style={{ height: 0.5, background: tokens.divider, marginLeft: 12 }}/>;
}

// カード内の1行。右端に「>」を出して、掘り下げられることを示す。
export function SettingsMenuRow({ label, onClick }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <PressableButton
      onClick={onClick}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10,
        padding: "12px 14px", background: "transparent", border: "none",
        cursor: "pointer", textAlign: "left",
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: tokens.text, flex: 1 }}>
        {label}
      </span>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none"
           stroke={tokens.textTertiary} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9 6 15 12 9 18"/>
      </svg>
    </PressableButton>
  );
}

// カード内の1行(ON/OFF切り替え用)。SettingsMenuRowと同じ余白・見た目で、
// 右端は「>」の代わりに丸いスイッチ(Toggle)を出す。
export function SettingsToggleRow({ label, description, checked, onChange, disabled = false }) {
  const { tokens } = useContext(ThemeContext);
  return (
    <div style={{
      width: "100%", display: "flex", alignItems: "center", gap: 10,
      padding: "12px 14px",
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tokens.text }}>{label}</div>
        {description && (
          <div style={{ fontSize: 11, color: tokens.textSecondary, marginTop: 3, lineHeight: 1.4 }}>
            {description}
          </div>
        )}
      </div>
      <Toggle on={checked} onChange={onChange} disabled={disabled}/>
    </div>
  );
}
