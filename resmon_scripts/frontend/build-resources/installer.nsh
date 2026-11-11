; resmon registers itself for resmon:// links for the person who runs it (HKCU). Uninstalling
; resmon removes that, so a link opened afterward is not handed to a program that is gone. An
; update runs the old uninstaller too; the handler stays then, and the new copy keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\resmon"
  ${endIf}
!macroend
