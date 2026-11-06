import { NavLink } from 'react-router'
import classes from './PageTabs.module.css'

// A page's views (Yours | Public, Binders | Prices) as links, so each view has its own address and Back works.
// The app's PagerTabs: the chosen one bright, with the brand gradient under it.
export function PageTabs({ label, tabs }: { label: string; tabs: { to: string; label: string }[] }) {
  return (
    <nav aria-label={label} className={classes.tabs}>
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end className={classes.tab}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  )
}
