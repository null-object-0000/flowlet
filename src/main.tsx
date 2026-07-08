import React from "react";
import ReactDOM from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import App from "./app/App";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./styles.css";

const theme = createTheme({
  fontFamily: '"Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif',
  primaryColor: "blue",
  defaultRadius: "sm",
  spacing: {
    xs: "6px",
    sm: "10px",
    md: "14px",
    lg: "18px",
    xl: "24px",
  },
  fontSizes: {
    xs: "11px",
    sm: "12px",
    md: "13px",
    lg: "15px",
    xl: "18px",
  },
  headings: {
    fontWeight: "700",
    sizes: {
      h1: { fontSize: "20px", lineHeight: "1.25" },
      h2: { fontSize: "18px", lineHeight: "1.3" },
      h3: { fontSize: "15px", lineHeight: "1.35" },
    },
  },
  components: {
    Button: {
      defaultProps: {
        size: "xs",
        radius: "sm",
      },
    },
    ActionIcon: {
      defaultProps: {
        size: "sm",
        radius: "sm",
      },
    },
    Paper: {
      defaultProps: {
        radius: "sm",
        withBorder: true,
      },
    },
    Card: {
      defaultProps: {
        radius: "sm",
        withBorder: true,
      },
    },
    TextInput: {
      defaultProps: {
        size: "xs",
        radius: "sm",
      },
    },
    PasswordInput: {
      defaultProps: {
        size: "xs",
        radius: "sm",
      },
    },
    Select: {
      defaultProps: {
        size: "xs",
        radius: "sm",
      },
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="light">
      <Notifications position="bottom-right" zIndex={1200} />
      <App />
    </MantineProvider>
  </React.StrictMode>
);
