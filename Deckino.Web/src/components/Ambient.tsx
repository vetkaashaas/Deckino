import classes from './Ambient.module.css'

// The one ambient background (landing hero, account pages): two soft orbs, purple and violet drifting slowly.
// Fills its nearest positioned parent; still under reduced motion.
export function Ambient() {
  return (
    <div className={classes.root} aria-hidden="true">
      <span className={classes.purple} />
      <span className={classes.violet} />
    </div>
  )
}
