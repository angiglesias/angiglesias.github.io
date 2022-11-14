+++
title = "Tired of pressing F-keys rebooting your PC for an update? Let's overengineer things"
date = "2022-11-13"
author = "Angel"
authorTwitter = "angel_iglesias1"
description = "Overengineering a few things to avoid pressing fkeys"
cover = "cover.jpg"
tags = ["linux", "sysadmin", "dual-boot", "systemd"]
+++

# Dual booting with Windows without renoucing to secure boot _et al_

This would have been easier by disabling secure boot on bios settings and calling it a day. But I wanted to keep bitlocker disk encryption and boot assurance using the tpm chip on my motherboard. Combining these settings, there's only one way to boot Windows witHout ending in a recovering screen asking for your recovery key: booting in UEFI to the windows boot manager. If you try to select Windows from Grub, you'll be greeted with a cyan screen asking for your recovery password.

Let's say you usually boot to windows because some program (or game) you usually use is only available for that OS, so you kept Windows as the default boot option. This left booting Linux to the f-key pressing ritual to select the correct boot option. On the bright side, managing the windows update thingie won't require pressing again f-keys to boot back again.

# Introducing Linux offline updates

I've using Fedora Linux on my work laptop for two years and loving the experience, but kept my desktop running KDE Neon (Ubuntu-based) because the nvidia gpu was _kinda problematic_ with the Wayland display manager. [This began to change in 2021](https://www.phoronix.com/news/NVIDIA-470-Wayland-Friendly) and nowadays, is more than feasible running a Wayland compositor on your nvidia gpu (yours truly wrote this on Fedora 36 running on an rtx30 series gpu).

Fedora upgrades are managed by pkgkit's offline upgrades system by default. After looking under the hood of the upgrade system, this method is enabled by the systemd upgrading system as follows:

* Pkgkit downloads the updates to apply to your computer.
* Pkgkit signals the availability of new updates to systemd (in our case, by establishing a symlink to the update directory in `/system-update`).
* After a reboot, systemd boots to the system-update target and runs the upgrade service(s) available to apply updates.
* After finishing the upgrade, systemd will reboot to the default boot target (in our case, graphical.target)

In the setup described before, updating Fedora and carrying on means two f-key cycles and supervision of the update, at the least, to start the update in the first reboot selecting the Linux boot target. This can be reduced to one f-key cycle with the help of `efibootmgr`. UEFI has the var `bootnext` which allows setting which boot target to load on the next reboot. For example, on my desktop:

```shell
[angel@indigo2 ~]$ efibootmgr
BootCurrent: 0004
Timeout: 1 seconds
BootOrder: 0000,0004
Boot0000* Windows Boot Manager
Boot0004* Fedora

# Usage
usage: efibootmgr [options]
	-a | --active         sets bootnum active
	-A | --inactive       sets bootnum inactive
	-b | --bootnum XXXX   modify BootXXXX (hex)
	-B | --delete-bootnum delete bootnum
	-c | --create         create new variable bootnum and add to bootorder
	-C | --create-only	create new variable bootnum and do not add to bootorder
	-D | --remove-dups	remove duplicate values from BootOrder
	-d | --disk disk       (defaults to /dev/sda) containing loader
	-r | --driver         Operate on Driver variables, not Boot Variables.
	-e | --edd [1|3|-1]   force EDD 1.0 or 3.0 creation variables, or guess
	-E | --device num      EDD 1.0 device number (defaults to 0x80)
	-g | --gpt            force disk with invalid PMBR to be treated as GPT
	-i | --iface name     create a netboot entry for the named interface
	-l | --loader name     (defaults to "\EFI\fedora\grub.efi")
	-L | --label label     Boot manager display label (defaults to "Linux")
	-m | --mirror-below-4G t|f mirror memory below 4GB
	-M | --mirror-above-4G X percentage memory to mirror above 4GB
	-n | --bootnext XXXX   set BootNext to XXXX (hex)
	-N | --delete-bootnext delete BootNext
	-o | --bootorder XXXX,YYYY,ZZZZ,...     explicitly set BootOrder (hex)
	-O | --delete-bootorder delete BootOrder
	-p | --part part        (defaults to 1) containing loader
	-q | --quiet            be quiet
	-t | --timeout seconds  set boot manager timeout waiting for user input.
	-T | --delete-timeout   delete Timeout.
	-u | --unicode | --UCS-2  handle extra args as UCS-2 (default is ASCII)
	-v | --verbose          print additional information
	-V | --version          return version and exit
	-w | --write-signature  write unique sig to MBR if needed
	-y | --sysprep          Operate on SysPrep variables, not Boot Variables.
	-@ | --append-binary-args file  append extra args from file (use "-" for stdin)
	-h | --help             show help/usage
```

With `efibootmgr -n 0004` Fedora is selected as the default boot target on the next reboot. Keeping this in mind, it seems like with this trick we can automate the update process to avoid pressing f-whatever on the next reboot to choose Linux.

# Systemd, (probable) cause and solution for all problems

The first thing that comes to mind is using systemd services to set the nextboot efivar to reload Linux again after a reboot, as it is at the heart of the upgrade system.

With the previously discussed information in mind, it's easy to write a service to set the efivar when the system is rebooted and an upgrade is ready to apply:

```conf
[Unit]
Description=Set UEFI bootnext to reload again linux when an offline upgrade is ready
DefaultDependencies=no
Before=shutdown.target
ConditionPathExists=/system-update

[Service]
Type=oneshot
ExecStart=/usr/local/bin/set-nextboot-to-current

[Install]
WantedBy=shutdown.target
```

The most important things here are:

* The condition `ConditionPathExists=/system-update` means the service is only executed when a system upgrade is signaled available to systemd.
* The dependencies with the target `shutdown` which set this service execution only happen when the system is being switched off.

On the other hand, booting back to Linux after the upgrade is finished, needs a little more consideration, as the system will reach the `reboot` target after successfully finishing the `system-update` one:

```conf
[Unit]
Description=Set UEFI nextboot to fedora after an system offline upgrade
DefaultDependencies=no
Requisite=system-update.target
After=system-update.target
Before=reboot.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/set-nextboot-to-current

[Install]
WantedBy=reboot.target
```

The most important things in this case are:

* The dependencies `Requisite=system-update.target` and `After=system-update.target` restrict the service execution only if `system-update` target was reached successfully.
* The dependencies with the `reboot` target restrict the service execution only when the computer will be restarted.

In both cases, the script `set-nextboot-to-current` is a simple bash script recovering the current booted target and setting UEFI's nextboot var:

```shell
#!/bin/sh

set -e

efibootmgr | grep "BootCurrent" | awk '{print $2}' | xargs -I {} efibootmgr -n {}
```

So that's it, a little bit of overengineering to avoid pressing f-something a keeping an eye on while the PC is updating.
