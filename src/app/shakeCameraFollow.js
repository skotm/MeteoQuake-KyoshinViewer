// 揺れ検知イベントの視点の追従(確定したイベントの観測点が画面に収まるよう調整する)。
// MapCanvas.jsx から使う。地図やDOMに直接触れる部分は mapFocus.js に任せ、「いつ動かすか」の
// 判断だけをここに持つ(時刻を引数で受け取るので、ユニットテストできる)。
//
// 動き:
//  - 最初の確定で、そのイベントの観測点が全部収まるように移動する("start")。
//  - その後、観測点が増えて画面の端からはみ出しそうになったら調整する("refit")。
//  - 追従中は別のイベントに乗り換えない(pickShakeFollowTarget参照)。
//  - ユーザーが地図を操作している間と、操作が終わってから resumeMs(2秒)の間は動かさない。
//    操作が終わって resumeMs 経ったら、設定(autoResume)がオンなら、イベントの観測点が収まる
//    ように合わせ直す("resume")。autoResumeがオフなら、動かしたイベントの自動調整は止めたまま。
import { pickShakeFollowTarget } from "../eewCameraFocus";
import { focusMapOnPoints, pointsNeedRefit } from "./mapFocus";

export const SHAKE_RESUME_MS = 2000;       // 操作が終わってから、自動のズームを再開するまでの無操作時間
export const SHAKE_REFIT_MIN_INTERVAL_MS = 900;

export class ShakeCameraFollower {
  constructor() { this.reset(); }

  reset() {
    this.eventId = null;
    this.lastFitAt = 0;
    this.points = [];
    this.userOverride = false; // ユーザーが動かした(自動調整を止めている)
    this.userMoving = false;   // 今まさにユーザーが地図を操作している
    this.lastUserAt = 0;
  }

  // ---- ユーザー操作(地図のイベントから呼ぶ) ----
  onUserMoveStart(nowMs) {
    this.userMoving = true;
    this.lastUserAt = nowMs;
    if (this.eventId != null) this.userOverride = true;
  }
  onUserMove(nowMs) { if (this.userMoving) this.lastUserAt = nowMs; }
  onUserMoveEnd(nowMs) {
    if (!this.userMoving) return;
    this.userMoving = false;
    this.lastUserAt = nowMs;
  }

  _idleEnough(nowMs, settings) {
    return settings.autoResume && !this.userMoving && nowMs - this.lastUserAt >= SHAKE_RESUME_MS;
  }

  _resume(map, isWide, nowMs) {
    this.userOverride = false;
    this.lastFitAt = nowMs;
    focusMapOnPoints(map, this.points, isWide, { duration: 800 });
    return "resume";
  }

  // 操作が終わってから一定時間後にタイマーから呼ぶ(tickとは別に、無操作の経過を確かめる)。
  checkResume({ map, isWide, nowMs, settings }) {
    if (!settings.shakeFollow || this.eventId == null || !this.userOverride || this.points.length === 0) return null;
    return this._idleEnough(nowMs, settings) ? this._resume(map, isWide, nowMs) : null;
  }

  // 揺れ検知エンジンを1tick進めるたびに呼ぶ。行った動作("start" | "refit" | "resume" | null)を返す。
  tick({ map, events, isWide, nowMs, settings }) {
    if (!settings.shakeFollow) { this.reset(); return null; }
    const { target, switched } = pickShakeFollowTarget(events, this.eventId);
    if (!target) {
      if (switched) { const moving = this.userMoving, at = this.lastUserAt; this.reset(); this.userMoving = moving; this.lastUserAt = at; }
      return null;
    }
    this.points = target.detections;
    if (switched) {
      this.eventId = target.id;
      this.lastFitAt = nowMs;
      if (this.userMoving) { this.userOverride = true; return null; } // 操作中なら、終わってから(resume)合わせる
      this.userOverride = false;
      focusMapOnPoints(map, this.points, isWide);
      return "start";
    }
    if (this.userOverride) return this._idleEnough(nowMs, settings) ? this._resume(map, isWide, nowMs) : null;
    if (nowMs - this.lastFitAt >= SHAKE_REFIT_MIN_INTERVAL_MS && pointsNeedRefit(map, this.points, isWide)) {
      this.lastFitAt = nowMs;
      focusMapOnPoints(map, this.points, isWide, { duration: 800 });
      return "refit";
    }
    return null;
  }
}
