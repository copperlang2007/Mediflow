import { useEffect, useState } from "react"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>
type ResolvedTheme = "light" | "dark"

// The app's dark mode is class-based (`@custom-variant dark` in index.css keys
// off a `.dark` ancestor), so the source of truth is the class on <html>, not
// the OS preference. Watching it keeps toasts in step with whatever sets it.
function readTheme(): ResolvedTheme {
  if (typeof document === "undefined") return "light"
  return document.documentElement.classList.contains("dark") ? "dark" : "light"
}

function useDocumentTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readTheme)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(readTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ["class"] })
    setTheme(readTheme())
    return () => observer.disconnect()
  }, [])

  return theme
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useDocumentTheme()

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
