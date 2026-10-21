import "./styles.css";
import { bindKeys } from "./keys";
import { openPdf, showStartScreen } from "./viewer";

showStartScreen();

bindKeys({
  "Ctrl+o": openPdf,
});
