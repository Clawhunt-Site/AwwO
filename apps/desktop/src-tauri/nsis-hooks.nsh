; ClawHunt NSIS installer hooks.
;
; POSTINSTALL: force the Windows shell to drop stale cached icons so the freshly
; installed ClawHunt icon (embedded in superclaw_desktop.exe at all sizes) shows
; immediately. Without this, a machine that previously had an icon-less build at
; the same per-user path keeps a blank/generic icon in its icon cache until the
; cache is manually rebuilt — which reads as "installed but no logo / white icon".
; SHChangeNotify(SHCNE_ASSOCCHANGED) tells the shell associations changed (flushes
; the icon cache, no Explorer restart); ie4uinit -show rebuilds the per-user cache.
!macro NSIS_HOOK_POSTINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

; POSTUNINSTALL: same refresh on removal so the (now dangling) icon is dropped.
!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
