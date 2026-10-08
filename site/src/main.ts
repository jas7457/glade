/**
 * The site's entry: styles, lazy videos, the copy button, and the scroll motion (GSAP).
 * Everything works without the motion: the HTML and CSS are the static, reduced-motion layout,
 * and src/motion/* only adds to it.
 */
import "./styles.css";
import { initCopyButtons } from "./copy.ts";
import { initMotion } from "./motion/index.ts";
import { initVideos } from "./videos.ts";

// Motion first: it may hold the hero video until the window has assembled.
initMotion();
initVideos();
initCopyButtons();
