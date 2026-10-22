import "./styles.css";
import { bindKeys } from "./keys";
import { getDoc, showStartScreen } from "./viewer";
import { initSettings } from "./settings";

bindKeys();
initSettings()
  .catch((err) => console.error(err))
  .finally(() => {
    if (!getDoc()) showStartScreen();
  });
