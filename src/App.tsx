import { useEffect, useState } from "react";
import { api } from "./api";
import Login from "./components/Login";
import WeekView from "./components/WeekView";

type AuthState = "loading" | "in" | "out";

export default function App() {
  const [auth, setAuth] = useState<AuthState>("loading");

  useEffect(() => {
    api
      .session()
      .then((s) => setAuth(s.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  if (auth === "loading") {
    return <div className="centered muted">Laddar…</div>;
  }

  if (auth === "out") {
    return <Login onSuccess={() => setAuth("in")} />;
  }

  return <WeekView onLogout={() => setAuth("out")} />;
}
