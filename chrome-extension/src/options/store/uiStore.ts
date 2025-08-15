import { create } from 'zustand';

interface DashboardUiState {
  isTestPanelOpen: boolean;
  toggleTestPanel: () => void;
  openTestPanel: () => void;
  closeTestPanel: () => void;
}

export const useDashboardUiStore = create<DashboardUiState>()((set) => ({
  isTestPanelOpen: false,
  toggleTestPanel: () => set((state) => ({ isTestPanelOpen: !state.isTestPanelOpen })),
  openTestPanel: () => set({ isTestPanelOpen: true }),
  closeTestPanel: () => set({ isTestPanelOpen: false })
}));
