import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { api, ApiError } from "@/lib/api";
import { theme } from "@/theme";
import { formatDistance, formatRands, formatTimeRange } from "@/lib/format";

interface OpenShift {
  id: string;
  startsAt: string;
  endsAt: string;
  hourlyRateCents: number;
  notes: string | null;
  pharmacyName: string;
  suburb: string | null;
  city: string;
  distanceMetres: number;
}

/**
 * §10.1 — shifts this locum can actually take, nearest first.
 *
 * The server decides what appears; no filtering happens here. A client that
 * received every open shift and hid some would still have shipped them to the
 * device, which is the scraping risk §12.1 names — and on a phone the payload
 * is trivially readable with a proxy.
 */
export function ShiftsScreen() {
  const [shifts, setShifts] = useState<OpenShift[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      setShifts(await api.query<OpenShift[]>("shifts.listOpenForMe", { limit: 25 }));
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "Could not load shifts");
      setShifts([]);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function apply(shiftId: string) {
    try {
      await api.mutate("bookings.applyToShift", {
        shiftId,
        /*
         * §11.5 — the scenario this exists for is literally a phone: a locum
         * on a train tapping Apply twice on a flaky connection. Without the
         * key the second tap is a second application and the manager sees the
         * same person listed twice.
         */
        idempotencyKey: `${shiftId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      setNotice("Applied. The pharmacy will confirm.");
      await load();
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : "Could not apply");
    }
  }

  if (shifts === null) return <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />;

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "600", color: theme.text, marginBottom: 4 }}>
        Find shifts
      </Text>
      {notice ? (
        <Text style={{ color: theme.textDim, marginBottom: 8 }}>{notice}</Text>
      ) : null}

      <FlatList
        data={shifts}
        keyExtractor={(shift) => shift.id}
        ListEmptyComponent={
          <Text style={{ color: theme.textDim, marginTop: 24 }}>
            Nothing open for you right now. Shifts appear when a pharmacy that has saved
            you posts one, or when a shift is advertised within your travel range.
          </Text>
        }
        renderItem={({ item }) => (
          <View
            style={{
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: theme.radius,
              padding: 14,
              marginBottom: theme.gap,
              gap: 6,
            }}
          >
            <Text style={{ fontWeight: "600", color: theme.text }}>
              {formatTimeRange(item.startsAt, item.endsAt)}
            </Text>
            <Text style={{ color: theme.textDim }}>
              {item.pharmacyName}
              {item.suburb ? `, ${item.suburb}` : `, ${item.city}`} ·{" "}
              {formatDistance(item.distanceMetres)} away
            </Text>
            <Text style={{ color: theme.text }}>
              {formatRands(item.hourlyRateCents)}/hour
            </Text>
            {item.notes ? (
              <Text style={{ color: theme.textDim, fontSize: 13 }}>{item.notes}</Text>
            ) : null}
            <Pressable
              onPress={() => void apply(item.id)}
              style={{
                backgroundColor: theme.accent,
                borderRadius: 8,
                paddingVertical: 10,
                alignItems: "center",
                marginTop: 4,
              }}
            >
              <Text style={{ color: theme.accentText, fontWeight: "600" }}>Apply</Text>
            </Pressable>
          </View>
        )}
      />
    </View>
  );
}
