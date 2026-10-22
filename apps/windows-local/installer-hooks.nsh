; Hooks of the AwwO Local installer (tauri.conf.json bundle.windows.nsis.installerHooks), saved as UTF-8 with a byte
; order mark: makensis reads an include without one in the ANSI code page.
;
; They run before Tauri's own check for a running app, which would end the window at once and leave AwwO 本地版's
; services stopping while their files are replaced or deleted. Instead the window is asked to quit (`--quit`, handed to
; the running window by the single-instance plugin, which stops AwwO 本地版 in order; with no window running it stops a
; database an earlier run left), and the installer waits until nothing runs from the payload any more: its folder can
; then be renamed. The renamed folder is removed, so an update leaves no file of the old payload behind and an
; uninstall leaves none either. The data folder (%LOCALAPPDATA%\store.clawhunt.awwo.local) is not touched, unless the
; uninstaller's 「删除应用程序数据」 is ticked and then confirmed.

; Seconds waited for the payload to be free.
Var AwwoWaited
; 1 when the installation folder is an installation of AwwO Local's (its payload, or its program and uninstaller, are
; there): only then is the folder the old payload is moved to removed, should one be left.
Var AwwoOurs
; The payload's deepest paths are 170 characters (MAX_RELATIVE_PATH in scripts/awwo-local-package.mjs): below a longer
; folder than this, they would pass Windows' 260.
!define AWWO_MAX_INSTDIR 80

; The window, asked to quit; with none running, what an earlier run left is stopped. Not waited for: a window that
; does not answer would hold the handover, and the wait below has a deadline of its own.
!macro AWWO_QUIT
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --quit'
  ${EndIf}
!macroend

!macro AWWO_STOP_AND_CLEAR_PAYLOAD
  !define AwwoID ${__LINE__}
  StrCpy $AwwoOurs 0
  ${If} ${FileExists} "$INSTDIR\payload\awwo-local-payload.json"
  ${OrIf} ${FileExists} "$INSTDIR\awwo-rm\awwo-local-payload.json"
    StrCpy $AwwoOurs 1
  ${ElseIf} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$INSTDIR\uninstall.exe"
    StrCpy $AwwoOurs 1
  ${EndIf}
  ; The old payload is moved to awwo-rm, a name of this hook's own as long as payload (so its paths, which installed,
  ; can be removed); one a removal that did not finish left goes first. Only in an installation of ours.
  ${If} $AwwoOurs = 1
  ${AndIf} ${FileExists} "$INSTDIR\awwo-rm\*.*"
    RMDir /r "$INSTDIR\awwo-rm"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\payload\awwo-local-payload.json"
    !insertmacro AWWO_QUIT
    StrCpy $AwwoWaited 0
    awwo_wait_${AwwoID}:
      ClearErrors
      ${IfNot} ${FileExists} "$INSTDIR\awwo-rm\*.*"
        Rename "$INSTDIR\payload" "$INSTDIR\awwo-rm"
        ${IfNot} ${Errors}
          RMDir /r "$INSTDIR\awwo-rm"
          Goto awwo_done_${AwwoID}
        ${EndIf}
      ${EndIf}
      ${If} $AwwoWaited = 0
        DetailPrint "正在等待 AwwO 本地版停止… Waiting for AwwO Local to stop…"
      ${EndIf}
      IntOp $AwwoWaited $AwwoWaited + 1
      ${If} $AwwoWaited < 360
        Sleep 1000
        ; A folder that would not go away at first may go now.
        RMDir /r "$INSTDIR\awwo-rm"
        Goto awwo_wait_${AwwoID}
      ${EndIf}
      IfSilent awwo_abort_${AwwoID}
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "AwwO 本地版仍在运行，或有程序（例如它的数据库 PostgreSQL）仍在使用它的文件。请退出 AwwO 本地版（菜单「AwwO → 退出」）后重试。$\n$\nAwwO Local is still running, or a program (its PostgreSQL database, for one) still uses its files. Quit AwwO Local (AwwO → Quit) and retry." IDRETRY awwo_retry_${AwwoID}
      awwo_abort_${AwwoID}:
        Abort "AwwO 本地版仍在运行。AwwO Local is still running."
      awwo_retry_${AwwoID}:
        ; Asked again: a window opened meanwhile, or a database left since, is stopped too.
        !insertmacro AWWO_QUIT
        StrCpy $AwwoWaited 0
        Goto awwo_wait_${AwwoID}
  ${EndIf}
  awwo_done_${AwwoID}:
  !undef AwwoID
!macroend

; Whether a folder ($0, a full path) is inside another ($1): $2 is 1 or 0.
!macro AWWO_INSIDE
  StrLen $3 "$1\"
  StrCpy $4 "$0\" $3
  ${If} $4 == "$1\"
    StrCpy $2 1
  ${Else}
    StrCpy $2 0
  ${EndIf}
!macroend

; Whether a path ($0) holds neither % nor !: $2 is 1 or 0. PostgreSQL starts its server and its bootstrap through
; cmd.exe, which reads them even inside quotes (%NAME%, and !NAME! where delayed expansion is on).
!macro AWWO_SHELL_SAFE
  StrCpy $2 1
  StrCpy $3 0
  ${Do}
    StrCpy $4 "$0" 1 $3
    ${If} $4 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $4 == "%"
    ${OrIf} $4 == "!"
      StrCpy $2 0
      ${ExitDo}
    ${EndIf}
    IntOp $3 $3 + 1
  ${Loop}
!macroend

; A folder refused: Tauri's section has made the installation folder by now (and made it the working folder, which
; cannot be removed), so it is removed again, if it is empty.
!macro AWWO_REFUSE MESSAGE
  IfSilent +2
  MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}"
  SetOutPath "$TEMP"
  RMDir "$INSTDIR"
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; The registers this uses are given back: the installer's own code goes on after it.
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrLen $0 "$INSTDIR"
  ${If} $0 > ${AWWO_MAX_INSTDIR}
    !insertmacro AWWO_REFUSE "安装位置的路径太长（超过 ${AWWO_MAX_INSTDIR} 个字符）：请选一个更短的位置。$\n$\nThe installation folder's path is longer than ${AWWO_MAX_INSTDIR} characters: choose a shorter one."
    Abort "安装位置的路径太长。The installation folder's path is too long."
  ${EndIf}
  ; The installation must be the person's own, in their profile or their %LOCALAPPDATA% (where the default,
  ; %LOCALAPPDATA%\AwwO Local, is; it may be moved out of the profile): AwwO's code runs there with their keys, and its
  ; module guard (scripts/awwo-local-module-guard.cjs) takes its folders for private. A folder elsewhere (D:\AwwO,
  ; C:\AwwO Local) takes its drive's permissions, under which other accounts may change its files. Its full path is
  ; compared, so a ".." cannot lead out (the folder as given, where Windows gives no full path for it). A folder led
  ; elsewhere by a junction, or given to others, is found by the window at its start (installation_trusted in
  ; src/main.rs), before anything of the payload runs.
  ClearErrors
  GetFullPathName $0 "$INSTDIR"
  ${If} ${Errors}
  ${OrIf} $0 == ""
    StrCpy $0 "$INSTDIR"
  ${EndIf}
  !insertmacro AWWO_SHELL_SAFE
  ${If} $2 = 0
    !insertmacro AWWO_REFUSE "安装位置的路径里不能有 % 或 !：AwwO 本地版的数据库 PostgreSQL 经 cmd.exe 启动，cmd.exe 会把它们当作变量的一部分。请换一个位置。$\n$\nThe installation folder's path may not hold % or !: PostgreSQL, AwwO Local's database, starts through cmd.exe, which reads them as part of a variable. Choose another folder."
    Abort "安装位置的路径里有 % 或 !。The installation folder's path holds % or !."
  ${EndIf}
  StrCpy $1 "$PROFILE"
  !insertmacro AWWO_INSIDE
  ${If} $2 = 0
    StrCpy $1 "$LOCALAPPDATA"
    !insertmacro AWWO_INSIDE
  ${EndIf}
  ${If} $2 = 0
    !insertmacro AWWO_REFUSE "请把 AwwO 本地版安装在你的用户目录（$PROFILE）之内，例如默认的位置：别处的文件夹，这台电脑上的其他账号可能改动其中的程序。$\n$\nInstall AwwO Local inside your user folder ($PROFILE), as in the place it suggests: elsewhere, other accounts on this computer may change its programs."
    Abort "安装位置不在用户目录之内。The installation folder is outside your user folder."
  ${EndIf}
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
  !insertmacro AWWO_STOP_AND_CLEAR_PAYLOAD
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Tauri's 「删除应用程序数据」 removes the whole data folder: everything of the person's. It is asked once more, saying
  ; so, with No as the answer given; a silent uninstall never removes it.
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "「删除应用程序数据」会删除 AwwO 本地版的全部数据：账号、画布、运行记录、上传和生成的文件、已保存的 API Key 和数据库，删除后无法恢复。确定删除？$\n$\n“Delete the application data” deletes all of AwwO Local's data: the account, canvases, runs, uploaded and generated files, saved API keys and the database. It cannot be undone. Delete it?" /SD IDNO IDYES awwo_delete_data
    StrCpy $DeleteAppDataCheckboxState 0
    awwo_delete_data:
  ${EndIf}
  !insertmacro AWWO_STOP_AND_CLEAR_PAYLOAD
!macroend
