import type { CSSProperties } from 'react'
import accountCircle from '@material-symbols/svg-400/outlined/account_circle.svg'
import add from '@material-symbols/svg-400/outlined/add.svg'
import backgroundGridSmall from '@material-symbols/svg-400/outlined/background_grid_small.svg'
import check from '@material-symbols/svg-400/outlined/check.svg'
import checkCircle from '@material-symbols/svg-400/outlined/check_circle.svg'
import chevronRight from '@material-symbols/svg-400/outlined/chevron_right.svg'
import close from '@material-symbols/svg-400/outlined/close.svg'
import cloudDone from '@material-symbols/svg-400/outlined/cloud_done.svg'
import collectionsBookmark from '@material-symbols/svg-400/outlined/collections_bookmark.svg'
import contentCopy from '@material-symbols/svg-400/outlined/content_copy.svg'
import contentPaste from '@material-symbols/svg-400/outlined/content_paste.svg'
import crown from '@material-symbols/svg-400/outlined/crown.svg'
import del from '@material-symbols/svg-400/outlined/delete.svg'
import documentScanner from '@material-symbols/svg-400/outlined/document_scanner.svg'
import download from '@material-symbols/svg-400/outlined/download.svg'
import driveFileMove from '@material-symbols/svg-400/outlined/drive_file_move.svg'
import edit from '@material-symbols/svg-400/outlined/edit.svg'
import favorite from '@material-symbols/svg-400/outlined/favorite.svg'
import filterList from '@material-symbols/svg-400/outlined/filter_list.svg'
import flip from '@material-symbols/svg-400/outlined/flip.svg'
import gridView from '@material-symbols/svg-400/outlined/grid_view.svg'
import home from '@material-symbols/svg-400/outlined/home.svg'
import image from '@material-symbols/svg-400/outlined/image.svg'
import keyboardArrowDown from '@material-symbols/svg-400/outlined/keyboard_arrow_down.svg'
import libraryAdd from '@material-symbols/svg-400/outlined/library_add.svg'
import layers from '@material-symbols/svg-400/outlined/layers.svg'
import link from '@material-symbols/svg-400/outlined/link.svg'
import moreHoriz from '@material-symbols/svg-400/outlined/more_horiz.svg'
import openInNew from '@material-symbols/svg-400/outlined/open_in_new.svg'
import playlistAdd from '@material-symbols/svg-400/outlined/playlist_add.svg'
import progressActivity from '@material-symbols/svg-400/outlined/progress_activity.svg'
import remove from '@material-symbols/svg-400/outlined/remove.svg'
import search from '@material-symbols/svg-400/outlined/search.svg'
import sell from '@material-symbols/svg-400/outlined/sell.svg'
import share from '@material-symbols/svg-400/outlined/share.svg'
import style from '@material-symbols/svg-400/outlined/style.svg'
import trendingDown from '@material-symbols/svg-400/outlined/trending_down.svg'
import trendingFlat from '@material-symbols/svg-400/outlined/trending_flat.svg'
import trendingUp from '@material-symbols/svg-400/outlined/trending_up.svg'
import tune from '@material-symbols/svg-400/outlined/tune.svg'
import upload from '@material-symbols/svg-400/outlined/upload_file.svg'
import viewModule from '@material-symbols/svg-400/outlined/view_module.svg'
import warning from '@material-symbols/svg-400/outlined/warning.svg'
import webStories from '@material-symbols/svg-400/outlined/web_stories.svg'
import zoomIn from '@material-symbols/svg-400/outlined/zoom_in.svg'
import zoomOut from '@material-symbols/svg-400/outlined/zoom_out.svg'
import appStore from './brand/brand-apple.svg'
import googlePlay from './brand/brand-google-play.svg'
import classes from './Icon.module.css'

// Material Symbols, named as on https://fonts.google.com/icons: the app's icons (Deckino.App/src/components/icon.tsx).
// Each is imported here, so only these reach the bundle; add one by importing its SVG.
const icons = {
  account_circle: accountCircle,
  add,
  background_grid_small: backgroundGridSmall,
  check,
  check_circle: checkCircle,
  chevron_right: chevronRight,
  close,
  cloud_done: cloudDone,
  collections_bookmark: collectionsBookmark,
  content_copy: contentCopy,
  content_paste: contentPaste,
  crown,
  delete: del,
  document_scanner: documentScanner,
  download,
  drive_file_move: driveFileMove,
  edit,
  favorite,
  filter_list: filterList,
  flip,
  grid_view: gridView,
  home,
  image,
  keyboard_arrow_down: keyboardArrowDown,
  layers,
  library_add: libraryAdd,
  link,
  more_horiz: moreHoriz,
  open_in_new: openInNew,
  playlist_add: playlistAdd,
  progress_activity: progressActivity,
  remove,
  search,
  sell,
  share,
  style,
  trending_down: trendingDown,
  trending_flat: trendingFlat,
  trending_up: trendingUp,
  tune,
  upload_file: upload,
  view_module: viewModule,
  warning,
  web_stories: webStories,
  zoom_in: zoomIn,
  zoom_out: zoomOut,
  // Store marks (Material Symbols has no brand icons).
  app_store: appStore,
  google_play: googlePlay,
}

export type IconName = keyof typeof icons

// Drawn in the text colour (a mask over currentColor). Decorative unless it has a label.
export function Icon({ name, size = 20, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <span
      className={className ? `${classes.icon} ${className}` : classes.icon}
      style={{ '--icon': `url("${icons[name]}")`, width: size, height: size } as CSSProperties}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
