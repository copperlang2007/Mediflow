import { create } from "zustand";

type AppUser = {
  id: string;
  orgId: string;
  role: string;
  fullName: string | null;
  avatarUrl: string | null;
};

type AppStore = {
  user: AppUser | null;
  sidebarCollapsed: boolean;
  setUser: (user: AppUser | null) => void;
  toggleSidebar: () => void;
};

export const useAppStore = create<AppStore>((set) => ({
  user: null,
  sidebarCollapsed: false,
  setUser: (user) => set({ user }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
