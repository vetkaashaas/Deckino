import classes from './Ambient.module.css'

// The one ambient background (landing hero, account pages): two soft brand-coloured orbs drifting slowly.
// Fills its nearest positioned parent; still under reduced motion.
export function Ambient() {
  return (
    <div className={classes.root} aria-hidden="true">
      <span className={classes.purple} />
      <span className={classes.pink} />
    </div>
  )
}
