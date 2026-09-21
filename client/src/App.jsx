import React from "react";
import { AuthProvider } from "./state/AuthContext.jsx";
import Workspace from "./pages/Workspace.jsx";

export default function App() {
  return (
    <AuthProvider>
      <Workspace />
    </AuthProvider>
  );
}
