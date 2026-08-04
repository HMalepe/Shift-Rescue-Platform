import { useEffect, useState } from "react";
import { SafeAreaView, StatusBar, Pressable, Text, View } from "react-native";
import { configureApi, readTokens, signOut } from "@/lib/api";
import { SignInScreen } from "@/screens/SignInScreen";
import { ShiftsScreen } from "@/screens/ShiftsScreen";
import { BookingsScreen, type MyBooking } from "@/screens/BookingsScreen";
import { CheckInScreen } from "@/screens/CheckInScreen";
import { theme } from "@/theme";

/**
 * Hand-rolled navigation rather than a router library.
 *
 * This app has four screens and one nesting level. React Navigation would add
 * a dependency, a linking configuration and a deep-link surface to buy
 * transitions and a back stack that `useState` already provides at this size.
 * When the screen count grows past what fits in one switch, swap it — that is
 * a contained change, and it is a much easier one to make later than to undo.
 */
type Screen =
  | { name: "shifts" }
  | { name: "bookings" }
  | { name: "checkIn"; booking: MyBooking };

export default function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "bookings" });

  useEffect(() => {
    configureApi({
      /*
       * `EXPO_PUBLIC_` is the only prefix Expo inlines into the bundle, and
       * everything inlined is readable by anyone who downloads the app. That
       * is fine for a base URL and would not be for a secret — this app holds
       * none, which is why the API authenticates every request rather than
       * trusting a shipped key.
       */
      baseUrl: process.env["EXPO_PUBLIC_API_URL"] ?? "http://localhost:3000",
    });
    void readTokens().then(({ refreshToken }) => setSignedIn(refreshToken !== null));
  }, []);

  if (signedIn === null) return <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }} />;

  if (!signedIn) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <StatusBar barStyle="dark-content" />
        <SignInScreen onSignedIn={() => setSignedIn(true)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <StatusBar barStyle="dark-content" />

      {screen.name === "checkIn" ? (
        <CheckInScreen
          booking={screen.booking}
          onDone={() => setScreen({ name: "bookings" })}
        />
      ) : (
        <>
          <View style={{ flex: 1 }}>
            {screen.name === "shifts" ? (
              <ShiftsScreen />
            ) : (
              <BookingsScreen
                onOpen={(booking) => setScreen({ name: "checkIn", booking })}
              />
            )}
          </View>

          <View
            style={{
              flexDirection: "row",
              borderTopWidth: 1,
              borderTopColor: theme.border,
              backgroundColor: theme.surface,
            }}
          >
            <Tab
              label="Find shifts"
              active={screen.name === "shifts"}
              onPress={() => setScreen({ name: "shifts" })}
            />
            <Tab
              label="My bookings"
              active={screen.name === "bookings"}
              onPress={() => setScreen({ name: "bookings" })}
            />
            <Tab
              label="Sign out"
              active={false}
              onPress={() => void signOut().then(() => setSignedIn(false))}
            />
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

function Tab({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={{ flex: 1, paddingVertical: 14, alignItems: "center" }}>
      <Text style={{ color: active ? theme.accent : theme.textDim, fontWeight: active ? "600" : "400" }}>
        {label}
      </Text>
    </Pressable>
  );
}
