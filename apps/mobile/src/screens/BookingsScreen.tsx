import { useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { api } from "@/lib/api";
import { theme } from "@/theme";
import { bookingStatusLabel, formatRands, formatTimeRange } from "@/lib/format";

export interface MyBooking {
  bookingId: string;
  status: string;
  shiftId: string;
  startsAt: string;
  endsAt: string;
  hourlyRateCents: number;
}

/**
 * The locum's own bookings, and the way into check-in.
 *
 * Confirmed shifts float to the top. A phone screen shows three or four cards,
 * and the one someone opens this app to find at 06:40 is the shift they are
 * about to walk into — not the application they sent last Tuesday.
 */
export function BookingsScreen({ onOpen }: { onOpen: (booking: MyBooking) => void }) {
  const [bookings, setBookings] = useState<MyBooking[] | null>(null);

  useEffect(() => {
    void api
      .query<MyBooking[]>("bookings.mine")
      .then(setBookings)
      .catch(() => setBookings([]));
  }, []);

  if (bookings === null) {
    return <ActivityIndicator style={{ marginTop: 40 }} color={theme.accent} />;
  }

  const sorted = [...bookings].sort((a, b) => {
    const rank = (s: string) => (s === "confirmed" ? 0 : s === "requested" ? 1 : 2);
    return rank(a.status) - rank(b.status) ||
      new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime();
  });

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <Text style={{ fontSize: 22, fontWeight: "600", color: theme.text, marginBottom: 8 }}>
        My bookings
      </Text>

      <FlatList
        data={sorted}
        keyExtractor={(booking) => booking.bookingId}
        ListEmptyComponent={
          <Text style={{ color: theme.textDim, marginTop: 24 }}>
            No bookings yet.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpen(item)}
            style={{
              backgroundColor: theme.surface,
              borderWidth: 1,
              borderColor: theme.border,
              borderRadius: theme.radius,
              padding: 14,
              marginBottom: theme.gap,
              gap: 4,
            }}
          >
            <Text style={{ fontWeight: "600", color: theme.text }}>
              {formatTimeRange(item.startsAt, item.endsAt)}
            </Text>
            <Text style={{ color: theme.textDim }}>
              {bookingStatusLabel(item.status)} · {formatRands(item.hourlyRateCents)}/hour
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}
