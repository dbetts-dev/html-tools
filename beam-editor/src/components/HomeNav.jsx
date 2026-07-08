export default function HomeNav() {
  return (
    <nav className="home-nav" aria-label="Return to home">
      <a className="home-nav__link" href="../">
        <span className="home-nav__arrow" aria-hidden="true">&#8592;</span>
        <span>axta tools</span>
      </a>
      <span className="home-nav__meta">v1.2 · 2026-07-08</span>
    </nav>
  )
}
