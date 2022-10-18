+++
title = "Playing around with a BMP388 or my first Linux Kernel contribution"
date = "2022-10-01"
author = "Angel"
authorTwitter = "angel_iglesias1"
cover = "tux.svg"
tags = ["linux", "kernel", "embedded"]
+++

# How it began

I started looking with a friend in building a small, advanced GPS tracker to use in canoeing.
We wanted something with low power consumption and a easy framework to develop a small proof-of-concept
quickly. We discovered this [awesome 4-in-one board from Ozzmaker](https://ozzmaker.com/product/berrygps-imu/)
that provided a full featured IMU.

An IMU, _Inertial Measurement Unit_ is a device used to record navigational
information that can be used later to compute the position of a body.
When an IMU, like this one, has GPS capabilities, allows for greater precision and
filling the gaps when GPS lock is lost. This IMU unit contains the following sensors:

* An satellite multifrequency global positioning system from u-blox, which provides main positioning and navigation data (u-blox M8).
* A high precision gyroscope + acceleromenter bundle, providing orientation and aceleration vectors (6-axis) ([STMicro LSM6DSL](https://www.st.com/en/mems-and-sensors/lsm6dsl.html)).
* A high precision magnetometer providing orientation relative to earth magnetic field (3-axis) ([STMicro LIS3MDL](https://www.st.com/en/mems-and-sensors/lis3mdl.html)).
* A high resolution barometric sensor, which records temperature and atmosferic pressure ([Bosch BMP388](https://www.bosch-sensortec.com/products/environmental-sensors/pressure-sensors/bmp388/))

All this sensors were supported in Linux kernel through the [Industrial I/O Subsystem (IIO)](https://www.kernel.org/doc/html/latest/driver-api/iio/intro.html)
but the BMP388. After a little bit of reading I discovered that the previous
generation of the sensors were supported and, in my blissful ignorance, I thought,
how hard could be to extend this driver to support the new sensors?

# Extending the driver

I had previous experience messing with kernel components and drivers at work,
from extending a intel network card driver with some cursed hacks to enable
a weird custom configuration to putting together a driver for a Sony CMOS sensor
with some outdated god-knows-where-it-came-from datasheets.
But those were quick-and-dirty attemps that, thankfully, never saw the light outside
a small engineering team. This time was the real deal, extending an existing driver
in the kernel and submitting the patches to the kernel mailing list.

With the datasheets from previous generations of sensors it was easy to follow
the driver logic and draw parallels with how the new sensor operated.
Taking the basics first, the sensor control interface provides a series of
registers to write and read data. These registers are accessible through
I2C and SPI interfaces. There are two types of registers:

* **read/write registers**, reserved to configure sensor operation, will store the data set by host.
* **read only registers**, that will contain various parameters exposed from the sensor, from flags to the raw data harvested in the sensor.
Bits from these registers can be volatile and will reset to default values after reading their content.

All registers are 8-bit words wide.

## Sensor operation

As happened with previous versions of the sensors, the data read on the sensor
needs to be compensated following and algorithm fed with calibration data
available on a reserved memory region. The region consists of 21 contiguous
registers starting on address 0x49 to 0x69. This compensation parameters are
comprised of signed and unsigned values of byte and two byte sizes:

| Parameter | Type | Address (high,low) |
|:---------:|:----:|:------------------:|
| T1 | uint16 | 0x32,0x31 | 
| T2 | uint16 | 0x34,0x33 |
| T3 | int8 | 0x35 |
| P1 | int16 | 0x37,0x36 |
| P2 | int16 | 0x39,0x38 |
| P3 | int8 | 0x3A |
| P4 | int8 | 0x3B |
| P5 | uint16 | 0x3D,0x3C |
| P6 | uint16 | 0x3F,0x3E |
| P7 | int8 | 0x40 |
| P8 | int8 | 0x41 |
| P9 | int16 | 0x43,0x42 |
| P10 | int8 | 0x44 |
| P11 | int8 | 0x45 |

After a power-on reset, to operate the sensor, a series of operation parameters
need to be configured:

* Operation Mode
* Oversampling (OSR)
* Output data rate (ODR)
* IIR filter

Additionally, the sensor has advanced capabilities such as interruptions and
FIFO measurements buffer not considered through this post.

### Sensor initialization

After a power-on-reset, the sensor is soft-reset issuing the reset command to
the CMD registry. After that the operation parameters will be set to default values.
During the different patch revisions, the initialization code suffered various changes.
At first it looked like this:

```c
static int bmp380_chip_config(struct bmp280_data *data)
{
	u8 osrs;
	unsigned int tmp;
	int ret;

	/* configure power control register */
	ret = regmap_write_bits(data->regmap, BMP380_REG_POWER_CONTROL,
				BMP380_CTRL_SENSORS_MASK |
				BMP380_MODE_MASK,
				BMP380_CTRL_SENSORS_PRESS_EN |
				BMP380_CTRL_SENSORS_TEMP_EN |
				BMP380_MODE_NORMAL);
	if (ret < 0) {
		dev_err(data->dev,
			"failed to write operation control register\n");
		return ret;
	}

	/* configure oversampling */
	osrs = BMP380_OSRS_TEMP_X(data->oversampling_temp) |
				BMP380_OSRS_PRESS_X(data->oversampling_press);

	ret = regmap_write_bits(data->regmap, BMP380_REG_OSR,
				BMP380_OSRS_TEMP_MASK | BMP380_OSRS_PRESS_MASK,
				osrs);
	if (ret < 0) {
		dev_err(data->dev, "failed to write oversampling register\n");
		return ret;
	}

	/* configure output data rate */
	ret = regmap_write_bits(data->regmap, BMP380_REG_ODR,
				BMP380_ODRS_MASK, data->sampling_freq);
	if (ret < 0) {
		dev_err(data->dev, "failed to write ODR selection register\n");
		return ret;
	}

	/* set filter data */
	ret = regmap_update_bits(data->regmap, BMP380_REG_CONFIG,
				BMP380_FILTER_MASK, BMP380_FILTER_3X);
	if (ret < 0) {
		dev_err(data->dev, "failed to write config register\n");
		return ret;
	}

	/* startup time wait to verify config */
	usleep_range(data->start_up_time, data->start_up_time + 100);

	/* check config error flag */
	ret = regmap_read(data->regmap, BMP380_REG_ERROR, &tmp);
	if (ret < 0) {
		dev_err(data->dev,
			"failed to read error register\n");
		return ret;
	}
	if (tmp && BMP380_ERR_CONF_MASK) {
		dev_warn(data->dev,
			 "sensor flagged configuration as incompatible\n");
		ret = -EINVAL;
	}

	return ret;
}
```

This code would enable temperature and pressure measurements and configure ODR
and oversampling. One problem found testing this code is that, in some cases,
the time waiting for config to apply before checking ERROR register is insuficient,
leaving the sensor in a incorrect state when a imcompatible configuration was applied.
A incorrect configuration can be a oversampling setting too high leading to a bigger
integration time than the waiting period between measurements.

A revised version of this code fixing this issue would wait the maximum measurement
time listed on the datasheet. This code also use `regmap_update_bits_check` to avoid
the sensor operation restart when no change is made to the preexisting configuration.

```c
static int bmp380_chip_config(struct bmp280_data *data)
{
	bool change = false, aux;
	unsigned int tmp;
	u8 osrs;
	int ret;

	/* Configure power control register */
	ret = regmap_update_bits(data->regmap, BMP380_REG_POWER_CONTROL,
				 BMP380_CTRL_SENSORS_MASK,
				 BMP380_CTRL_SENSORS_PRESS_EN |
				 BMP380_CTRL_SENSORS_TEMP_EN);
	if (ret) {
		dev_err(data->dev,
			"failed to write operation control register\n");
		return ret;
	}

	/* Configure oversampling */
	osrs = FIELD_PREP(BMP380_OSRS_TEMP_MASK, data->oversampling_temp) |
	       FIELD_PREP(BMP380_OSRS_PRESS_MASK, data->oversampling_press);

	ret = regmap_update_bits_check(data->regmap, BMP380_REG_OSR,
				       BMP380_OSRS_TEMP_MASK |
				       BMP380_OSRS_PRESS_MASK,
				       osrs, &aux);
	if (ret) {
		dev_err(data->dev, "failed to write oversampling register\n");
		return ret;
	}
	change = change || aux;

	/* Configure output data rate */
	ret = regmap_update_bits_check(data->regmap, BMP380_REG_ODR,
				       BMP380_ODRS_MASK, data->sampling_freq, &aux);
	if (ret) {
		dev_err(data->dev, "failed to write ODR selection register\n");
		return ret;
	}
	change = change || aux;

	/* Set filter data */
	ret = regmap_update_bits_check(data->regmap, BMP380_REG_CONFIG, BMP380_FILTER_MASK,
				       FIELD_PREP(BMP380_FILTER_MASK, data->iir_filter_coeff),
				       &aux);
	if (ret) {
		dev_err(data->dev, "failed to write config register\n");
		return ret;
	}
	change = change || aux;

	if (change) {
		/*
		 * The configurations errors are detected on the fly during a measurement
		 * cycle. If the sampling frequency is too low, it's faster to reset
		 * the measurement loop than wait until the next measurement is due.
		 *
		 * Resets sensor measurement loop toggling between sleep and normal
		 * operating modes.
		 */
		ret = regmap_write_bits(data->regmap, BMP380_REG_POWER_CONTROL,
					BMP380_MODE_MASK,
					FIELD_PREP(BMP380_MODE_MASK, BMP380_MODE_SLEEP));
		if (ret) {
			dev_err(data->dev, "failed to set sleep mode\n");
			return ret;
		}
		usleep_range(2000, 2500);
		ret = regmap_write_bits(data->regmap, BMP380_REG_POWER_CONTROL,
					BMP380_MODE_MASK,
					FIELD_PREP(BMP380_MODE_MASK, BMP380_MODE_NORMAL));
		if (ret) {
			dev_err(data->dev, "failed to set normal mode\n");
			return ret;
		}
		/*
		 * Waits for measurement before checking configuration error flag.
		 * Selected longest measure time indicated in section 3.9.1
		 * in the datasheet.
		 */
		msleep(80);

		/* Check config error flag */
		ret = regmap_read(data->regmap, BMP380_REG_ERROR, &tmp);
		if (ret) {
			dev_err(data->dev,
				"failed to read error register\n");
			return ret;
		}
		if (tmp & BMP380_ERR_CONF_MASK) {
			dev_warn(data->dev,
				"sensor flagged configuration as incompatible\n");
			return -EINVAL;
		}
	}

	return 0;
}
```

The Operation Mode can be set to: `sleep`, `forced` and `normal`. Sleep sets
the sensor to standby, in force mode will make only one measurement and in
normal sensor takes a measuremt with the frequency set in ODR.
Oversampling settings will control the resolution of the measurements in combination
with the noise smoothing provided by the IIR filter. The section 3.5. of the datasheet
provides more insigths on typical uses and the recommended settings for each scenario.


## Integrating the changes

The driver already provides support for various sensors: `bmp085`, `bmp180`,
`bmp280` and `bme280`, so it was quite modularized already.
Integrating the new sensor required adding new IDs to the I2C and SPI match
tables and a additional regmap definition for the new sensor and integrating
the new codepath for the actual sensor operations. During the different iterations,
the patchset grew from a simple extension to a more serious refactor a modernization
of the existing driver before landing the support for the new sensor.

The refactor and modernization changes included:

* [Fix broken datasheet links](https://github.com/torvalds/linux/commit/5d5129b17f8315d317db01a3f6e050e8ca23952f)
* [Reorder local variables definitions following reverse xmas tree rule](https://github.com/torvalds/linux/commit/5f0c359defea73c0ca27fb47a3a891abf2f5a504)
* [Migrated driver codebase to use FIELD_GET, FIELD_SET and GENMASK macros](https://github.com/torvalds/linux/commit/2405f8cc8485d7c06fdd7b85a0df1a3febd076d6)
* [Simplified bmp280 calibration reading codepath](https://github.com/torvalds/linux/commit/83cb40beaefaf59b224efdabecaac611b783da74)
* [Refactor driver initialization logic, unifying sensor initialization and extending parameters stored on chip_info struct](https://github.com/torvalds/linux/commit/b00e805a47a86fb5890a1c2451e4d89043b1761d)
* [Fix possible DMA issues derived from using buffers stored in stack](https://github.com/torvalds/linux/commit/327b5c0512c18287162d0f12949aae41d64358b0)
* [Redorder i2c device tables declarations](https://github.com/torvalds/linux/commit/18d1bb377023cad76e01b598da3da53da9fc36b7)

The actual changes adding support for the BMP380 sensor:

* [Core changes adding support for the BMP380 sensors](https://github.com/torvalds/linux/commit/8d329309184d5824e44c6426bf878c5f1e1156e5)
* [Driver extension adding sampling frequency and IIR filter controls using sysfs ABI](https://github.com/torvalds/linux/commit/10b40ffba2f95cdeed47b731c5ad5ecc73e140e8)

# Getting the patches upstream

There's a lot on ink out there on how to preapre and send your patches to the
kernel mailing lists. I've spent a few weeks scratching my head and still managed
to botch my first patch submission. Don't let this discourage you,
the guides online and the people in the mailing list were really helpful.

On top of my head, some handy resources were:

* [Submitting patches: the essential guide to getting your code into the kernel](https://www.kernel.org/doc/html/v6.0/process/submitting-patches.html)
* [Linux Kernel patch submission checklist¶](https://www.kernel.org/doc/html/v6.0/process/submit-checklist.html)
* [Submitting Your First Patch to the Linux Kernel and Responding to Feedback](https://nickdesaulniers.github.io/blog/2017/05/16/submitting-your-first-patch-to-the-linux-kernel-and-responding-to-feedback/)
* [A guide to the Kernel Development Process](https://www.kernel.org/doc/html/v6.0/process/development-process.html)

I don't think I can say more than what's written on those links, but on my experience
I would add:

1. When generating a patchset with **_git format-patch_** it can add for you `In-Reply-To`
headers using the `--thread` flag that will link the patches later when they arrive
to the mail list.
2. Adding the flag `--cover-letter` to **_git format-patch_** will pregenerate a cover letter
for you patchset where you can explain the changes and provide more insights.
3. Don't forget to use the flag `--base=<commit or branch>` generating patches to
**_git format-patch_**. This will provide extra information to the maintainers about
the base that your changes branched from.
4. When you're generating a new version of the patches, **_git format-patch_** will add the new
version prefix using the flag `-v<number>`
5. It is preferible to send new patches versions without replying to previous versions
to keep mail lists under control. It is common link to previous versions on the cover
letter of the new version.
6. `scripts/checkpatch.pl` can work in tamden with `codespell` to detect typos in your patches.
7. Don't forget to sign off your patches and include everyone involved in development using the
`Signed-off-by` and `Co-developed-by` tags.

# Next steps

This was a really enriching experience. While working on this patches I stumbled across parts of
the kernel I didn't know beforehand.
Although the patches have been accepted and are on their way toward kernel 6.1, the work doesn't end here.
I've got in my hands two new sensors deriving from the BMP380, the BMP390L and the BMP580
and I plan to extend the driver again adding support for this two sensors very soon:tm:.

Now that first batch of features from rust-for-linux are expected to be merged
in kernel 6.1, I would love to get my first taste at advanced rust porting the
driver to rust.

# Acknowledgments

I would like to thank the patches reviewers, Jonathan Cameron, Andy Shevchenko and
Krzysztof Kozlowski. Their feedback was essential to shape the patches. And also, apologies
for managing to send three times in a row the patches separated instead than linked in a thread :sweat_smile:
