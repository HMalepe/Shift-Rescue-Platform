import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { signIn } from "@/lib/api";
import { theme } from "@/theme";

/** Sign in with email and password. */
export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await signIn({ email: email.trim(), password });
    setBusy(false);
    if (result.ok) onSignedIn();
    else setError(result.message);
  }

  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: theme.gap }}>
      <Text style={{ fontSize: 26, fontWeight: "700", color: theme.text }}>
        Locum Planner
      </Text>
      <Text style={{ color: theme.textDim, marginBottom: 8 }}>
        Relief pharmacist shifts across Gauteng.
      </Text>

      {error ? (
        <Text style={{ color: theme.danger }} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <Field
        label="Email"
        value={email}
        onChange={setEmail}
        autoComplete="username"
        keyboardType="email-address"
      />
      <Field
        label="Password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        secure
      />

      {busy ? (
        <ActivityIndicator color={theme.accent} />
      ) : (
        <Pressable
          onPress={() => void submit()}
          style={{
            backgroundColor: theme.accent,
            borderRadius: 8,
            paddingVertical: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: theme.accentText, fontWeight: "600" }}>Sign in</Text>
        </Pressable>
      )}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  secure,
  autoComplete,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  secure?: boolean;
  autoComplete?: "username" | "current-password";
  keyboardType?: "email-address";
}) {
  const [visible, setVisible] = useState(false);

  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: theme.text }}>{label}</Text>
      <View>
        <TextInput
          value={value}
          onChangeText={onChange}
          secureTextEntry={secure === true && !visible}
          autoCapitalize="none"
          autoCorrect={false}
          {...(autoComplete ? { autoComplete } : {})}
          {...(keyboardType ? { keyboardType } : {})}
          style={{
            borderWidth: 1,
            borderColor: theme.border,
            borderRadius: 8,
            padding: 12,
            paddingRight: secure ? 48 : 12,
            backgroundColor: theme.surface,
            color: theme.text,
          }}
        />
        {secure ? (
          <Pressable
            onPress={() => setVisible((current) => !current)}
            accessibilityLabel={visible ? "Hide password" : "Show password"}
            accessibilityRole="button"
            style={{
              position: "absolute",
              right: 4,
              top: 0,
              bottom: 0,
              justifyContent: "center",
              paddingHorizontal: 8,
            }}
          >
            <Text style={{ color: theme.textDim, fontSize: 18 }}>{visible ? "🙈" : "👁"}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
