import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

/**
 * App-wide toast host for the `sonner` library. Most pages call
 * `toast.success(...)` / `toast.error(...)` from "sonner" directly; without
 * this mounted once at the app root those messages are silently dropped.
 *
 * Styled with the agencyBRIDGE tokens (card surface, theme text, coloured
 * icon per kind) and follows the light/dark theme.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={(resolvedTheme === "dark" ? "dark" : "light") as ToasterProps["theme"]}
      position="top-right"
      closeButton
      offset={{ top: 72, right: 20 }}
      mobileOffset={{ top: 64 }}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast font-sans group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg group-[.toaster]:rounded-xl",
          title: "font-semibold",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success: "[&_[data-icon]]:text-success",
          error: "[&_[data-icon]]:text-destructive",
          warning: "[&_[data-icon]]:text-warning",
          info: "[&_[data-icon]]:text-accent",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
