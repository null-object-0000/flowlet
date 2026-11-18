import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { EcosystemSection } from "./components/EcosystemSection";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { LocalFirstSection } from "./components/LocalFirstSection";
import { Nav } from "./components/Nav";
import { ProductDemoSection } from "./components/ProductDemoSection";
import { StartSection } from "./components/StartSection";
import { TraceSection } from "./components/TraceSection";
import styles from "./LandingPage.module.css";

export function LandingPage() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    const section = hash === "#why" || hash === "#how" ? "trace" : hash.slice(1);
    if (section) document.getElementById(section)?.scrollIntoView?.();
  }, [hash, pathname]);

  return (
    <div className={styles.page}>
      <Nav />
      <main>
        <Hero />
        <ProductDemoSection />
        <TraceSection />
        <EcosystemSection />
        <LocalFirstSection />
        <StartSection />
      </main>
      <Footer />
    </div>
  );
}
