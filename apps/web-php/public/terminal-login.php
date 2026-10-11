<?php
declare(strict_types=1);

if (!defined('QSYN_TERMINAL_LOGIN_TEMPLATE')) {
    http_response_code(404);
    exit;
}
$h = static fn(string $value): string => htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>QSYN · Administrator Sign-In</title>
  <link rel="stylesheet" href="/qsyn/assets/terminal-gate.css">
</head>
<body>
  <main class="gate-shell">
    <section class="gate-panel" aria-labelledby="gate-title">
      <p class="gate-eyebrow">QSYN · RESTRICTED TERMINAL</p>
      <h1 id="gate-title"><?= $configured ? 'Administrator sign-in' : 'Administrator setup' ?></h1>
      <p class="gate-intro">Terminal dashboards, brokers, workspaces, operations and diagnostics require the QSYN administrator password. The chart-only homepage remains public.</p>
      <?php if ($message !== ''): ?>
        <p class="gate-error" role="alert"><?= $h($message) ?></p>
      <?php endif; ?>
      <?php if ($configured): ?>
        <form method="post" action="/qsyn/terminal/login" autocomplete="off">
          <input type="hidden" name="csrf" value="<?= $h($csrf) ?>">
          <label for="qsyn-admin-password">QSYN administrator password</label>
          <input id="qsyn-admin-password" name="password" type="password"
            autocomplete="current-password" minlength="1" maxlength="1024" required autofocus>
          <button type="submit">Unlock terminal</button>
        </form>
      <?php elseif ($setupAvailable): ?>
        <p class="gate-info">First-time setup uses the private one-time code from Cloudways' protected QSYN runtime. The code is never displayed on this page.</p>
        <form method="post" action="/qsyn/terminal/login" autocomplete="off">
          <input type="hidden" name="csrf" value="<?= $h($csrf) ?>">
          <label for="qsyn-setup-code">Private setup code</label>
          <input id="qsyn-setup-code" name="setup_code" type="password"
            autocomplete="off" minlength="64" maxlength="64" required>
          <label for="qsyn-new-password">New administrator password (20+ characters)</label>
          <input id="qsyn-new-password" name="new_password" type="password"
            autocomplete="new-password" minlength="20" maxlength="1024" required>
          <label for="qsyn-confirm-password">Confirm password</label>
          <input id="qsyn-confirm-password" name="confirm_password" type="password"
            autocomplete="new-password" minlength="20" maxlength="1024" required>
          <button type="submit">Create password and unlock</button>
        </form>
      <?php else: ?>
        <p class="gate-error" role="status">Administrator sign-in has not been configured. Check the existing private QSYN administrator settings with an authorized Cloudways operator. Access remains closed.</p>
      <?php endif; ?>
      <a class="gate-home" href="/qsyn/">← Back to chart homepage</a>
      <p class="gate-footnote">No broker order execution is enabled by signing in.</p>
    </section>
  </main>
</body>
</html>
