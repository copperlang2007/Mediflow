/**
 * "Book appointment" hook for a contact's page header (stage2/calendar-branding).
 * Self-contained: renders its own button and dialog so the host page only
 * needs one line.
 */
import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppointmentDialog } from "./AppointmentDialog";

export function BookAppointmentButton({ contactId, contactName }: { contactId: string; contactName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} aria-label="Book appointment" title="Book appointment">
        <CalendarPlus className="h-4 w-4 mr-1" />
        Book
      </Button>
      <AppointmentDialog
        open={open}
        onOpenChange={setOpen}
        defaults={{ contact: { id: contactId, name: contactName } }}
      />
    </>
  );
}
