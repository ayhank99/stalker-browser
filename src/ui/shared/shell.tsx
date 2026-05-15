import React from 'react'

type ShellProps = {
  page: 'editor' | 'server' | 'dashboard'
  title: string
  subtitle: string
  status?: string
  children: React.ReactNode
}

const navItems = [
  { key: 'dashboard', href: '/', label: 'Dashboard', icon: 'D', cls: 'ic-dashboard' },
  { key: 'control', href: '/control-panel.html', label: 'Kontrol Panel', icon: 'K', cls: 'ic-stalker' },
  { key: 'channels', href: '/channels.html', label: 'Kanallar', icon: 'C', cls: 'ic-xtream' },
  { key: 'editor', href: '/editor.html', label: 'Editor', icon: 'E', cls: 'ic-editor' },
  { key: 'server', href: '/tv-server.html', label: 'TV Sunucu', icon: 'T', cls: 'ic-server' }
]

export function Shell(props: ShellProps) {
  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand">
          <div className="brand-logo">▶</div>
          IPTV <span>Manager</span>
        </div>
        <div className="nav-links">
          {navItems.map((item) => (
            <a
              key={item.key}
              className={'nav-link' + (props.page === item.key ? ' active' : '')}
              href={item.href}
            >
              <span className={'nav-icon icon-badge ' + item.cls}>{item.icon}</span>
              {item.label}
            </a>
          ))}
        </div>
        <div className="topbar-right">
          <span className="server-badge">{props.status || '● Canli'}</span>
        </div>
      </div>

      <div className={'page page-' + props.page}>
        <div className="page-stack">
          <div className="card">
            <div className="card-title">{props.title}</div>
            <div className="section-copy">{props.subtitle}</div>
          </div>
          {props.children}
        </div>
      </div>
    </div>
  )
}
