class UiStore {
  loading = $state(true);
  queryRunning = $state(false);
  loadingMessage = $state('Opening table…');
  error = $state<string | null>(null);
  exportProgress = $state<number | null>(null);
  exportDonePath = $state<string | null>(null);

  setLoading(active: boolean, message = ''): void {
    this.loading = active;
    this.loadingMessage = message;
    if (active) this.error = null;
  }

  setError(message: string): void { this.error = message; this.loading = false; }

  setExportDone(path?: string): void {
    this.exportProgress = null;
    this.exportDonePath = path ?? null;
    if (path) setTimeout(() => { this.exportDonePath = null; }, 4000);
  }
}
export const uiStore = new UiStore();
