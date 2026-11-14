// The sign-in screen for one saved connection, as launch shows it after the dashboard turned the password down, so
// `shoot.mjs` can screenshot it. `?mode=light` for the light theme.
import { createRoot } from "react-dom/client";
import "../../src/styles.css";
import { SignInFailure } from "../../src/hermes/setup";
import { appearanceStore } from "../../src/ui/appearance";
import { SignIn } from "../../src/ui/SignIn";

const mode = new URLSearchParams(location.search).get("mode") ?? "dark";
localStorage.setItem("hermes-chat.appearance", JSON.stringify({ scheme: mode }));
appearanceStore(localStorage, document.documentElement);

const connection = { id: "conn-home-0001", name: "Home server", mode: "url" as const, sshTarget: "", url: "https://hermes.home.example.net", username: "liam", addedAt: 0 };
const error = new SignInFailure({ stage: "sign-in", message: "The dashboard answered 401: invalid credentials", answered: { status: 401, body: "invalid credentials" } });
createRoot(document.getElementById("root")!).render(
  <SignIn connection={connection} initial={{ mode: "url", sshTarget: "", url: connection.url, username: "liam", password: "" }} error={error} onSignIn={async () => {}} />,
);
