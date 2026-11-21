import { useState, type ComponentType } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Activity, BookOpen, Bot, Command, LayoutDashboard, Menu, MessageSquare, PanelLeft, Play, Plug, ScrollText, Settings, Users, Workflow, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useBootstrap } from '@/lib/queries';
import { ProjectSwitcher } from './ProjectSwitcher';
import { ThreadList } from './ThreadList';
import { CommandPalette } from './CommandPalette';
import { Tooltip } from './InfoTip';
import { Toaster, ThemeToggle, cn } from './ui';

/** De-cluttered navigation: three working groups + one reference group. */
const NAV: { group: string; items: { to: string; icon: ComponentType<{ className?: string }>; label: string; end?: boolean }[] }[] = [
  { group: 'Work', items: [
    { to: '/chat', icon: MessageSquare, label: 'Chat' },
    { to: '/runs/new', icon: Play, label: 'New run' },
  ] },
  { group: 'Build', items: [
    { to: '/agents', icon: Bot, label: 'Agents' },
    { to: '/teams', icon: Users, label: 'Teams' },
  ] },
  { group: 'Operate', items: [
    { to: '/team-runs', icon: Workflow, label: 'Team runs' },
    { to: '/runs', icon: Activity, label: 'Runs' },
    { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/mcp', icon: Plug, label: 'MCP registry' },
    { to: '/audit', icon: ScrollText, label: 'Audit & logs' },
  ] },
  { group: 'System', items: [
    { to: '/developers', icon: BookOpen, label: 'API docs' },
  ] },
];

function Item({ to, icon: Icon, label, end, collapsed }: { to: string; icon: ComponentType<{ className?: string }>; label: string; end?: boolean; collapsed: boolean }) {
  const link = (
    <NavLink to={to} end={end} aria-label={label} title={collapsed ? undefined : label}
      className={({ isActive }) => cn('mx-2 flex h-10 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors',
        collapsed && 'justify-center px-0',
        isActive ? 'bg-accent/12 text-accent font-medium' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
      <Icon className="size-4 shrink-0" />{!collapsed && <span className="truncate">{label}</span>}
    </NavLink>
  );
  return collapsed ? <Tooltip content={label} side="right">{link}</Tooltip> : link;
}

export function Shell() {
  const { sidebarCollapsed, toggleSidebar, setPaletteOpen } = useApp();
  const { data: boot } = useBootstrap();
  const nav = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const collapsed = sidebarCollapsed;
  const asideInner = (
    <>
      <div className={cn('flex items-center gap-2 px-3 py-3.5', collapsed && 'justify-center px-2')}>
        <button onClick={() => { nav('/chat'); setMobileOpen(false); }} className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Minions Cockpit home">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-base text-accent-fg">M</span>
          {!collapsed && <span className="whitespace-nowrap">Minions Cockpit</span>}
        </button>
        {!collapsed && (
          <div className="ml-auto flex items-center gap-0.5">
            <ThemeToggle />
            <button onClick={() => setPaletteOpen(true)} className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted hover:text-fg" aria-label="Command palette">
              <Command className="size-3" />K
            </button>
          </div>
        )}
      </div>
      {!collapsed && <div className="px-3 pb-2"><ProjectSwitcher /></div>}

      <nav className="flex-1 overflow-y-auto pb-2">
        {NAV.map((g) => (
          <div key={g.group} className="border-t border-border/60 pt-1 first:border-t-0">
            {!collapsed && <div className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{g.group}</div>}
            {g.items.map((it) => <Item key={it.to} {...it} collapsed={collapsed} />)}
            {g.group === 'Work' && !collapsed && (
              <div className="mt-1 max-h-[38vh] overflow-y-auto border-t border-border/40 pt-1"><ThreadList /></div>
            )}
          </div>
        ))}
      </nav>

      <div className={cn('flex items-center gap-1 border-t border-border px-2 py-2', collapsed && 'flex-col')}>
        <NavLink to="/settings" aria-label="Settings" title="Settings"
          className={({ isActive }) => cn('flex h-10 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-sm', collapsed && 'flex-none justify-center px-0', isActive ? 'bg-accent/12 text-accent font-medium' : 'text-muted hover:bg-surface-2/60 hover:text-fg')}>
          <Settings className="size-4 shrink-0" />{!collapsed && 'Settings'}
        </NavLink>
        <ThemeToggle />
        {!collapsed && <span className="px-1 text-[10px] text-muted">v{boot?.version}</span>}
        <button onClick={toggleSidebar} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex h-10 w-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
          <PanelLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full">
      {/* Desktop rail / full sidebar */}
      <aside className={cn('hidden lg:flex shrink-0 flex-col border-r border-border bg-bg transition-[width] duration-200', collapsed ? 'w-16' : 'w-64')}>{asideInner}</aside>

      {/* Mobile drawer */}
      <button onClick={() => setMobileOpen(true)} aria-label="Open navigation"
        className="fixed left-3 top-3 z-30 flex size-9 items-center justify-center rounded-lg border border-border bg-bg text-muted shadow-sm lg:hidden">
        <Menu className="size-4" />
      </button>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border bg-bg">
            <button onClick={() => setMobileOpen(false)} aria-label="Close navigation"
              className="absolute right-2 top-3 flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2"><X className="size-4" /></button>
            {asideInner}
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 overflow-hidden"><Outlet /></main>
      <CommandPalette />
      <Toaster />
    </div>
  );
}
