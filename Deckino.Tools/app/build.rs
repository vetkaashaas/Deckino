// The exe's icon (Explorer, the taskbar, the installer's shortcuts).
fn main() {
    let mut resource = winresource::WindowsResource::new();
    resource.set_icon("assets/deckino.ico");
    resource.compile().expect("Windows resources");
}
