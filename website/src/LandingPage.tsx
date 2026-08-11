import { EcosystemSection } from "./components/EcosystemSection";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Nav } from "./components/Nav";
import { ProductDemoSection } from "./components/ProductDemoSection";
import { StartSection } from "./components/StartSection";
import { TraceSection } from "./components/TraceSection";
import styles from "./LandingPage.module.css";

export function LandingPage() {
  return (
    <div className={styles.page}>
      <Nav />
      <main>
        <Hero />
        <ProductDemoSection />
        <TraceSection />
        <EcosystemSection />
        <StartSection />
      </main>
      <Footer />
    </div>
  );
}
