import { Agents } from "./components/Agents";
import { Boundaries } from "./components/Boundaries";
import { Channels } from "./components/Channels";
import { Features } from "./components/Features";
import { Footer } from "./components/Footer";
import { Hero } from "./components/Hero";
import { Nav } from "./components/Nav";
import { Quickstart } from "./components/Quickstart";
import { Security } from "./components/Security";
import styles from "./LandingPage.module.css";

export function LandingPage() {
  return (
    <div className={styles.page}>
      <Nav />
      <main>
        <Hero />
        <Features />
        <Channels />
        <Agents />
        <Quickstart />
        <Security />
        <Boundaries />
      </main>
      <Footer />
    </div>
  );
}
