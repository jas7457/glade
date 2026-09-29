/** Stub (I-164 steps 4–5). */
import { useNavigate } from "react-router";
import { NavBar, PhoneButton, Screen, ScreenBody } from "~/ui/phone";

export function NewChatScreen() {
  const navigate = useNavigate();
  return (
    <Screen>
      <NavBar
        title="NewChatScreen"
        left={
          <PhoneButton kind="plain" onClick={() => navigate(-1)}>
            Back
          </PhoneButton>
        }
      />
      <ScreenBody>{null}</ScreenBody>
    </Screen>
  );
}
