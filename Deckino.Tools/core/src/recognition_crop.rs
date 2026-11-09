//! recognition_crop_v1: the phone rectifies a card to CARD_WIDTH×CARD_HEIGHT and recognizes the box from (LEFT, TOP)
//! to (RIGHT, BOTTOM). Mirrors CARD_ART_BOX in the training package, which the exported model hands to the app as its
//! crop contract.
pub const CARD_WIDTH: u32 = 315;
pub const CARD_HEIGHT: u32 = 440;
pub const LEFT: u32 = 25;
pub const TOP: u32 = 48;
pub const RIGHT: u32 = 290;
pub const BOTTOM: u32 = 216;
