// The app mark. A fixed path in the public folder, never an imported asset: it holds the neutral mark in the
// build, and `scripts/app-install` may replace the file on the operator's machine with their herdr-app icon.
// Keeping it out of the bundle means the built bundle never contains herdr-app art.
export default `${import.meta.env.BASE_URL}icons/app-logo.png`;
