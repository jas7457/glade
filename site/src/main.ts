/**
 * The site's entry: styles, the hero's story player, lazy videos, the copy button, and the scroll
 * motion (GSAP). Everything works without the motion: the HTML and CSS are the static,
 * reduced-motion layout, and src/motion/* only adds to it.
 */
import "./styles.css";
import { initCopyButtons } from "./copy.ts";
import { initMotion } from "./motion/index.ts";
import { initStory } from "./story.ts";
import { initVideos } from "./videos.ts";

initStory();
initMotion();
initVideos();
initCopyButtons();
