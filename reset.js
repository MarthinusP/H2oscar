function main() {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";

  const form = document.getElementById("reset-form");
  const noTokenMsg = document.getElementById("no-token-msg");
  const statusEl = document.getElementById("reset-status");
  const btn = document.getElementById("reset-btn");

  if (!token) {
    form.hidden = true;
    noTokenMsg.hidden = false;
    return;
  }

  form.addEventListener("submit", async (evt) => {
    evt.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "status-msg";

    const newPassword = document.getElementById("new-password").value;
    const confirmPassword = document.getElementById("confirm-password").value;

    if (newPassword.length < 8) {
      statusEl.textContent = "Password must be at least 8 characters.";
      statusEl.className = "status-msg error";
      return;
    }
    if (newPassword !== confirmPassword) {
      statusEl.textContent = "Passwords don't match.";
      statusEl.className = "status-msg error";
      return;
    }

    btn.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/api/reset-confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      if (res.ok) {
        statusEl.textContent = "Password updated. You can use it on the dashboard now.";
        statusEl.className = "status-msg ok";
        form.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
      } else if (res.status === 400) {
        statusEl.textContent = "This link has expired or was already used. Request a new one from the dashboard.";
        statusEl.className = "status-msg error";
        btn.disabled = false;
      } else {
        statusEl.textContent = "Something went wrong (" + res.status + "). Try again.";
        statusEl.className = "status-msg error";
        btn.disabled = false;
      }
    } catch {
      statusEl.textContent = "Couldn't reach the server. Check your connection and try again.";
      statusEl.className = "status-msg error";
      btn.disabled = false;
    }
  });
}

main();
