use framework "AppKit"
use framework "Foundation"
use scripting additions

property statusItem : missing value
property detailItem : missing value
property refreshTimer : missing value
property titleCommand : ""
property detailCommand : ""
property refreshInterval : 10

on run argv
  if (count of argv) < 2 then error "ai-battery macOS status item requires title and detail commands"

  set titleCommand to item 1 of argv
  set detailCommand to item 2 of argv
  if (count of argv) is greater than or equal to 3 then
    try
      set refreshInterval to (item 3 of argv) as real
    end try
  end if

  current application's NSApplication's sharedApplication()
  current application's NSApp's setActivationPolicy:(current application's NSApplicationActivationPolicyAccessory)

  set statusItem to current application's NSStatusBar's systemStatusBar()'s statusItemWithLength:(current application's NSVariableStatusItemLength)
  statusItem's button()'s setTitle:"AI --"
  statusItem's button()'s setToolTip:"AI Battery"

  set statusMenu to current application's NSMenu's alloc()'s initWithTitle:"AI Battery"
  set detailItem to current application's NSMenuItem's alloc()'s initWithTitle:"Loading..." action:(missing value) keyEquivalent:""
  detailItem's setEnabled:false
  statusMenu's addItem:detailItem
  statusMenu's addItem:(current application's NSMenuItem's separatorItem())

  set refreshItem to current application's NSMenuItem's alloc()'s initWithTitle:"Refresh" action:"refresh:" keyEquivalent:"r"
  refreshItem's setTarget:me
  statusMenu's addItem:refreshItem

  set quitItem to current application's NSMenuItem's alloc()'s initWithTitle:"Quit AI Battery" action:"quit:" keyEquivalent:"q"
  quitItem's setTarget:me
  statusMenu's addItem:quitItem

  statusItem's setMenu:statusMenu
  my refresh_(missing value)

  set refreshTimer to current application's NSTimer's scheduledTimerWithTimeInterval:refreshInterval target:me selector:"refresh:" userInfo:(missing value) repeats:true
  current application's NSRunLoop's currentRunLoop()'s addTimer:refreshTimer forMode:(current application's NSRunLoopCommonModes)
  current application's NSApp's run()
end run

on refresh_(sender)
  set titleText to "AI --"
  set detailText to "AI Battery unavailable"

  try
    set titleText to do shell script titleCommand
  end try

  try
    set detailText to do shell script detailCommand
  end try

  if titleText is "" then set titleText to "AI --"
  if detailText is "" then set detailText to "AI Battery unavailable"

  statusItem's button()'s setTitle:titleText
  statusItem's button()'s setToolTip:detailText
  detailItem's setTitle:detailText
end refresh_

on quit_(sender)
  try
    refreshTimer's invalidate()
  end try
  current application's NSStatusBar's systemStatusBar()'s removeStatusItem:statusItem
  current application's NSApp's terminate:me
end quit_
