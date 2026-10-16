export const DAILY_UPLOAD_TIME = "00:10";
export const dailyUploadAt = date => new Date(`${date}T${DAILY_UPLOAD_TIME}:00Z`).getTime();

export function startDailyScheduler(check, log = console.error) {
  let stopped = false, running = false, timer;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try { await check(new Date()); }
    catch { await log("[magpie-tokscale-import] Daily schedule check failed. Check saved credentials, account selection, state permissions, and UTC configuration; no success was recorded."); }
    finally {
      running = false;
      if (!stopped) {
        // Recompute from UTC each time; short checks also recover missed runs and due retries.
        const now = Date.now();
        const todayUpload = dailyUploadAt(new Date(now).toISOString().slice(0, 10));
        const nextUpload = todayUpload > now ? todayUpload : todayUpload + 86400000;
        timer = setTimeout(() => { void tick(); }, Math.min(60000, Math.max(1, nextUpload - now)));
        timer.unref?.();
      }
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
