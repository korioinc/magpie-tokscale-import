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
        const midnight = new Date(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z").getTime() + 86400000;
        timer = setTimeout(() => { void tick(); }, Math.min(60000, Math.max(1, midnight - now)));
        timer.unref?.();
      }
    }
  };
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
