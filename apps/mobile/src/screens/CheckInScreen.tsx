import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api";
import { captureAttendance, explainCaptureFailure } from "@/lib/location";
import { theme } from "@/theme";
import { formatTimeRange } from "@/lib/format";

interface Attendance {
  checkedInAt: string | null;
  checkedOutAt: string | null;
  checkInDistanceM: number | null;
}

/**
 * §8 — check in and out.
 *
 * The screen that justifies this app existing. Everything else here a mobile
 * browser could do; this could not, because `isFromMockProvider()` has no web
 * equivalent (§16).
 *
 * Three things it deliberately does not do:
 *
 * It does not compute distance from the pharmacy. That is measured server-side
 * against the pharmacy's stored location — a distance calculated on the device
 * is a number the device chose, and §8 wants evidence.
 *
 * It does not block a check-in on any anomaly. §8 keeps these as signals
 * because "a false positive that voids a real pharmacist's shift is worse than
 * a missed spoof", and a pharmacy that cannot trade because an app disliked a
 * GPS reading is the worse outcome by a wide margin.
 *
 * It does not tell the user which anomalies were recorded. Someone who can see
 * that "implausible_accuracy" fired learns exactly what to change; the signals
 * are for the reviewer of a dispute, not for the person being reviewed.
 */
export function CheckInScreen({
  booking,
  onDone,
}: {
  booking: { bookingId: string; startsAt: string; endsAt: string };
  onDone: () => void;
}) {
  const [attendance, setAttendance] = useState<Attendance | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    const record = await api
      .query<Attendance | null>("attendance.mine", { bookingId: booking.bookingId })
      .catch(() => null);
    setAttendance(record);
    setLoaded(true);
  }

  if (!loaded) {
    void load();
  }

  async function record(procedure: "attendance.checkIn" | "attendance.checkOut") {
    setBusy(true);
    setNotice(null);

    const capture = await captureAttendance();
    const failure = explainCaptureFailure(capture);
    if (capture.kind !== "captured") {
      setNotice(failure);
      setBusy(false);
      return;
    }

    try {
      await api.mutate(procedure, {
        bookingId: booking.bookingId,
        ...capture.signals,
      });
      await load();
      setNotice(procedure === "attendance.checkIn" ? "Checked in." : "Checked out.");
    } catch (error) {
      setNotice(
        error instanceof ApiError ? error.message : "Could not record attendance",
      );
    } finally {
      setBusy(false);
    }
  }

  const canCheckIn = attendance?.checkedInAt == null;
  const canCheckOut = attendance?.checkedInAt != null && attendance.checkedOutAt == null;

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: theme.gap }}>
      <Pressable onPress={onDone}>
        <Text style={{ color: theme.accent }}>← Back</Text>
      </Pressable>

      <Text style={{ fontSize: 22, fontWeight: "600", color: theme.text }}>
        {formatTimeRange(booking.startsAt, booking.endsAt)}
      </Text>

      <View
        style={{
          backgroundColor: theme.surface,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: theme.radius,
          padding: 16,
          gap: theme.gap,
        }}
      >
        <Text style={{ color: theme.textDim }}>
          {attendance?.checkedInAt
            ? `Checked in at ${new Date(attendance.checkedInAt).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false })}`
            : "Not checked in yet."}
          {attendance?.checkedOutAt
            ? `\nChecked out at ${new Date(attendance.checkedOutAt).toLocaleTimeString("en-ZA", { timeZone: "Africa/Johannesburg", hour: "2-digit", minute: "2-digit", hour12: false })}`
            : ""}
        </Text>

        {busy ? <ActivityIndicator color={theme.accent} /> : null}

        {canCheckIn && !busy ? (
          <Button label="Check in" onPress={() => void record("attendance.checkIn")} />
        ) : null}
        {canCheckOut && !busy ? (
          <Button label="Check out" onPress={() => void record("attendance.checkOut")} />
        ) : null}

        {notice ? (
          <Text style={{ color: theme.textDim, fontSize: 13 }}>{notice}</Text>
        ) : null}
      </View>

      <Text style={{ color: theme.textDim, fontSize: 12, lineHeight: 18 }}>
        {/*
          Said plainly rather than buried in a privacy policy. The app is
          about to read a precise location and send it somewhere, and someone
          standing at a pharmacy door deserves to know what for and for how
          long — §10 consent means little if the person consenting has to
          guess.
        */}
        Checking in records where you are, once, to confirm you arrived. It is not
        tracked between check-in and check-out, and never when the app is closed.
      </Text>
    </ScrollView>
  );
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: theme.accent,
        borderRadius: 8,
        paddingVertical: 12,
        alignItems: "center",
      }}
    >
      <Text style={{ color: theme.accentText, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
